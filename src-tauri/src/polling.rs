//! Background polling loops mirroring the TUI's orchestration: PR status
//! checks (persisted to the shared state store) and auto-pull of project main
//! branches (blocked reasons surfaced on project headers).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use claude_commander_core::git::{
    check_pr_for_branch, is_gh_available, run_project_pull, PullOutcome,
};
use futures::StreamExt;

use crate::service::service;

/// Cap concurrent `gh` fan-outs (each holds 3+ pipe FDs; macOS defaults to a
/// 256-FD limit under launchd). Mirrors the TUI's PR_FANOUT_CONCURRENCY.
const PR_FANOUT_CONCURRENCY: usize = 8;
const PULL_FANOUT_CONCURRENCY: usize = 4;

/// Blocked reason per project id, read by `build_groups` for header badges.
pub static PULL_BLOCKED: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn spawn_polling_loops() {
    spawn_pr_loop();
    spawn_project_pull_loop();
    spawn_hibernation();
}

/// Start claude-commander's idle-hibernation policy loop. The service no-ops
/// unless `hibernate_enabled` is set with a non-zero check interval, so this is
/// safe to call unconditionally at startup — it mirrors how the TUI starts the
/// same loop for a long-lived frontend. Hibernated sessions surface as a
/// distinct sidebar state with a Wake action (see `groups::SessionRow`).
fn spawn_hibernation() {
    tauri::async_runtime::spawn(async move {
        if let Ok(svc) = service().await {
            svc.start_hibernation_loop();
        }
    });
}

/// True while a manual PR-status refresh is running, so a second trigger is a
/// no-op rather than stacking another `gh` fan-out (e.g. a double-Enter on the
/// palette command). Mirrors claude-commander's debounce of the same action.
static MANUAL_PR_REFRESH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Palette "Refresh PR status": run one PR-status sweep immediately instead of
/// waiting for the periodic loop. Debounced — returns early if a manual refresh
/// is already in flight. The sidebar reflects the result on its next loop tick.
#[tauri::command]
pub async fn refresh_pr_status() -> Result<(), String> {
    if MANUAL_PR_REFRESH_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let outcome = run_manual_pr_refresh().await;
    MANUAL_PR_REFRESH_IN_FLIGHT.store(false, Ordering::SeqCst);
    outcome
}

async fn run_manual_pr_refresh() -> Result<(), String> {
    if !is_gh_available().await {
        return Err("gh CLI not available".to_string());
    }
    let svc = service().await?;
    poll_prs_once(svc).await;
    Ok(())
}

/// Every `pr_check_interval_secs`: check the PR for each session's branch via
/// `gh`, and persist the result exactly the way the TUI does (including
/// clearing on authoritative not-found, preserving on transient failure, and
/// re-running section assignment).
fn spawn_pr_loop() {
    tauri::async_runtime::spawn(async move {
        // Startup grace so launch doesn't immediately fan out `gh` calls.
        tokio::time::sleep(Duration::from_secs(5)).await;
        if !is_gh_available().await {
            tracing::info!("gh not available; PR polling disabled");
            return;
        }
        loop {
            let interval = match service().await {
                Ok(svc) => {
                    poll_prs_once(svc).await;
                    svc.read_config().pr_check_interval_secs.max(30)
                }
                Err(_) => 120,
            };
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

async fn poll_prs_once(svc: &claude_commander_core::api::CommanderService) {
    // Adopt any branch renames first so this same sweep queries GitHub with
    // the corrected `--head` name, mirroring the TUI's poll loop.
    if let Err(e) = svc.reconcile_session_branches().await {
        tracing::debug!("reconcile_session_branches failed: {e}");
    }
    let sessions: Vec<(
        claude_commander_core::session::SessionId,
        String,
        std::path::PathBuf,
        chrono::DateTime<chrono::Utc>,
    )> = {
        let state = svc.store().read().await;
        state
            .sessions
            .values()
            .filter(|s| s.status != claude_commander_core::session::SessionStatus::Creating)
            .filter_map(|s| {
                let project = state.projects.get(&s.project_id)?;
                Some((
                    s.id,
                    s.branch.clone(),
                    project.repo_path.clone(),
                    s.branch_owned_since(),
                ))
            })
            .collect()
    };
    if sessions.is_empty() {
        return;
    }

    let results: Vec<_> = futures::stream::iter(sessions.into_iter().map(
        |(session_id, branch, repo_path, owned_since)| async move {
            let result = check_pr_for_branch(&repo_path, &branch, owned_since).await;
            (session_id, result)
        },
    ))
    .buffer_unordered(PR_FANOUT_CONCURRENCY)
    .collect()
    .await;

    // Persist, re-run section assignment, and refresh tmux status bars —
    // the same library path the TUI's poll loop uses.
    if let Err(e) = svc.apply_pr_results(results).await {
        tracing::debug!("apply_pr_results failed: {e}");
    }
}

/// Every minute, sweep projects and fast-forward main branches that are due
/// (per `project_pull_interval_secs`). Blocked reasons land in `PULL_BLOCKED`.
fn spawn_project_pull_loop() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let mut last_pull: HashMap<String, std::time::Instant> = HashMap::new();
        loop {
            if let Ok(svc) = service().await {
                let interval = Duration::from_secs(svc.read_config().project_pull_interval_secs);
                let projects: Vec<(String, std::path::PathBuf, String)> = {
                    let state = svc.store().read().await;
                    state
                        .projects
                        .values()
                        .map(|p| (p.id.to_string(), p.repo_path.clone(), p.main_branch.clone()))
                        .collect()
                };
                let due: Vec<_> = projects
                    .into_iter()
                    .filter(|(id, _, _)| last_pull.get(id).is_none_or(|t| t.elapsed() >= interval))
                    .collect();
                let outcomes: Vec<(String, PullOutcome)> =
                    futures::stream::iter(due.into_iter().map(|(id, path, main)| async move {
                        let outcome = run_project_pull(&path, &main).await;
                        (id, outcome)
                    }))
                    .buffer_unordered(PULL_FANOUT_CONCURRENCY)
                    .collect()
                    .await;
                for (id, outcome) in outcomes {
                    last_pull.insert(id.clone(), std::time::Instant::now());
                    let mut blocked = PULL_BLOCKED.lock().unwrap();
                    match outcome {
                        PullOutcome::Advanced | PullOutcome::UpToDate => {
                            blocked.remove(&id);
                        }
                        PullOutcome::Blocked(reason) => {
                            blocked.insert(id, reason.as_str().to_string());
                        }
                        // A fetch failure says nothing new — keep prior state.
                        PullOutcome::SoftFail => {}
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
