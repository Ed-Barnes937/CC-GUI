//! The grouped session list pushed to the sidebar, refreshed on a 2s loop.

use std::collections::HashMap;
use std::time::Duration;

use claude_commander_core::agent::AgentKind;
use claude_commander_core::api::CommanderService;
use claude_commander_core::git::effective_pr_state;
use claude_commander_core::tmux::AgentStateDetector;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::service::service;

pub const SESSIONS_REFRESH_MS: u64 = 2000;

#[derive(Serialize, Clone)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub branch: String,
    pub status: String,
    pub program: String,
    pub agent_state: String,
    pub tmux_session_name: String,
    pub pr_number: Option<u32>,
    pub pr_url: Option<String>,
    /// Effective PR state ("open"/"closed"/"merged"), None when no PR.
    pub pr_state: Option<String>,
    pub pr_draft: bool,
    pub pr_labels: Vec<String>,
    pub review_decision: Option<String>,
    pub has_pending_comments: bool,
    pub unread: bool,
    /// Stopped by the auto-hibernation policy (as opposed to a manual kill).
    /// A hibernated session is `status == "stopped"`; the frontend renders it
    /// distinctly and offers a Wake action (which resumes the prior agent).
    pub hibernated: bool,
    /// Rendered one indent level under its stack parent.
    pub stacked_child: bool,
    /// Full uuid of the owning project (matches `ProjectGroup.id`); lets section
    /// views group their sessions under project sub-headers.
    pub project_id: String,
    pub project_name: String,
    /// Cached current section (None = the implicit "In Progress").
    pub current_section: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    /// Why the main-branch auto-pull is blocked (e.g. "local commits"), if it is.
    pub pull_blocked: Option<String>,
    pub sessions: Vec<SessionRow>,
}

/// Full uuid for a project id. `ProjectId`'s `Display` truncates to 8 chars
/// (and unlike `SessionId` it has no `as_uuid` accessor), but the frontend
/// must round-trip ids through `parse_project_id`, which needs the full uuid.
fn project_uuid(id: &claude_commander_core::session::ProjectId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| id.to_string())
}

/// Snapshot projects + sessions from the shared state store. Agent states are
/// filled by the caller (the polling loop has the detector; the initial
/// `get_groups` call reports "unknown" and lets the next tick correct it).
pub async fn build_groups(
    svc: &CommanderService,
    mut detect: Option<&mut AgentStateDetector>,
) -> Vec<ProjectGroup> {
    let (projects, sessions) = {
        let state = svc.store().read().await;
        let projects: Vec<_> = state.projects.values().cloned().collect();
        let sessions: Vec<_> = state.sessions.values().cloned().collect();
        (projects, sessions)
    };
    let pending_comments = svc
        .sessions_with_pending_comments()
        .await
        .unwrap_or_default();

    let mut projects = projects;
    projects.sort_by(|a, b| a.name.cmp(&b.name));

    let mut groups: Vec<ProjectGroup> = Vec::with_capacity(projects.len());
    for p in projects {
        let project_sessions: Vec<&claude_commander_core::session::WorktreeSession> =
            sessions.iter().filter(|s| s.project_id == p.id).collect();
        let mut rows = Vec::with_capacity(project_sessions.len());
        for (s, stacked_child) in session_display_order(&project_sessions) {
            let agent_state = match detect.as_deref_mut() {
                Some(d) if s.status.is_active() => {
                    let kind = AgentKind::from_program(&s.program);
                    format!("{:?}", d.detect(kind, &s.tmux_session_name).await).to_lowercase()
                }
                _ => "unknown".to_string(),
            };
            rows.push(SessionRow {
                id: s.id.as_uuid().to_string(),
                title: s.title.clone(),
                branch: s.branch.clone(),
                status: s.status.to_string(),
                program: s.program.clone(),
                agent_state,
                tmux_session_name: s.tmux_session_name.clone(),
                pr_number: s.pr_number,
                pr_url: s.pr_url.clone(),
                pr_state: s.pr_number.map(|_| {
                    effective_pr_state(s.pr_state, s.pr_merged)
                        .to_string()
                        .to_lowercase()
                }),
                pr_draft: s.pr_draft,
                pr_labels: s.pr_labels.clone(),
                review_decision: s.review_decision.map(|d| format!("{d:?}").to_lowercase()),
                has_pending_comments: pending_comments.contains(&s.id),
                unread: s.unread,
                hibernated: s.hibernated,
                stacked_child,
                project_id: project_uuid(&p.id),
                project_name: p.name.clone(),
                current_section: s.current_section.clone(),
            });
        }
        groups.push(ProjectGroup {
            id: project_uuid(&p.id),
            name: p.name.clone(),
            repo_path: p.repo_path.to_string_lossy().to_string(),
            pull_blocked: crate::polling::PULL_BLOCKED
                .lock()
                .unwrap()
                .get(&p.id.to_string())
                .cloned(),
            sessions: rows,
        });
    }
    groups
}

/// Display order for a project's sessions, mirroring the TUI: root sessions
/// (unstacked + stack bases) newest-first by `created_at`, each stack's
/// children following their root depth-first in creation order, flagged for
/// indentation.
fn session_display_order<'a>(
    sessions: &[&'a claude_commander_core::session::WorktreeSession],
) -> Vec<(&'a claude_commander_core::session::WorktreeSession, bool)> {
    use claude_commander_core::session::resolve_stack_parent;
    let mut roots: Vec<_> = Vec::new();
    let mut children_by_parent: HashMap<
        claude_commander_core::session::SessionId,
        Vec<&claude_commander_core::session::WorktreeSession>,
    > = HashMap::new();
    for s in sessions {
        match resolve_stack_parent(*s, sessions) {
            Some(parent_id) => children_by_parent.entry(parent_id).or_default().push(s),
            None => roots.push(*s),
        }
    }
    roots.sort_by_key(|s| std::cmp::Reverse(s.created_at));
    for children in children_by_parent.values_mut() {
        children.sort_by_key(|s| s.created_at);
    }
    let mut out = Vec::new();
    for root in roots {
        out.push((root, false));
        let mut to_visit: Vec<_> = children_by_parent
            .get(&root.id)
            .cloned()
            .unwrap_or_default();
        to_visit.reverse();
        while let Some(next) = to_visit.pop() {
            out.push((next, true));
            if let Some(grandchildren) = children_by_parent.get(&next.id) {
                for gc in grandchildren.iter().rev() {
                    to_visit.push(gc);
                }
            }
        }
    }
    out
}

#[derive(Serialize, Clone)]
pub struct SectionBucket {
    pub name: String,
    /// Session ids (full uuids) in display order.
    pub session_ids: Vec<String>,
}

/// Everything the sidebar renders: grouped sessions, section buckets (whenever
/// sections are configured), the "move to section" names, and the commander
/// chip. The active view mode is GUI-owned (persisted in the frontend's
/// localStorage, like theming), so the backend no longer tracks it — it just
/// supplies the section data and the frontend picks the layout.
#[derive(Serialize, Clone)]
pub struct Snapshot {
    pub groups: Vec<ProjectGroup>,
    /// Section buckets, present whenever sections are configured (the frontend
    /// renders them only in its section views).
    pub sections: Option<Vec<SectionBucket>>,
    /// Names available for "move to section" (configured sections only).
    pub section_names: Vec<String>,
    pub commander: crate::commander::CommanderStatus,
}

pub async fn build_snapshot(
    svc: &CommanderService,
    detect: Option<&mut AgentStateDetector>,
) -> Snapshot {
    let groups = build_groups(svc, detect).await;
    let config_sections = svc.read_config().sections;
    // Section buckets are the same for either section view (flat vs stacks) —
    // the frontend chooses the layout — so compute them whenever sections are
    // configured and let the frontend ignore them in project view.
    let sections = if config_sections.is_empty() {
        None
    } else {
        let state = svc.store().read().await;
        let sessions: Vec<_> = state.sessions.values().cloned().collect();
        Some(
            claude_commander_core::session::build_sections(&sessions, &config_sections)
                .into_iter()
                .map(|s| SectionBucket {
                    name: s.name,
                    session_ids: s
                        .sessions
                        .iter()
                        .map(|id| id.as_uuid().to_string())
                        .collect(),
                })
                .collect(),
        )
    };
    Snapshot {
        groups,
        sections,
        section_names: config_sections.iter().map(|s| s.name.clone()).collect(),
        commander: crate::commander::commander_status().await,
    }
}

#[tauri::command]
pub async fn get_groups() -> Result<Snapshot, String> {
    let svc = service().await?;
    let _ = svc.store().reload_if_changed().await;
    Ok(build_snapshot(svc, None).await)
}

/// Move a session to a section (manual pin), or clear its pin when `section`
/// is None. Uses the library's placement semantics: override for
/// predicate-less sections, soft placement for predicate-bearing ones.
#[tauri::command]
pub async fn move_to_section(id: String, section: Option<String>) -> Result<(), String> {
    let sid = crate::service::parse_session_id(&id)?;
    let svc = service().await?;
    let sections = svc.read_config().sections;
    let now = chrono::Utc::now();
    svc.store()
        .mutate(move |state| {
            if let Some(session) = state.get_session_mut(&sid) {
                match &section {
                    Some(name) => {
                        claude_commander_core::session::place_created_session(
                            session, name, &sections, now,
                        );
                    }
                    None => {
                        claude_commander_core::session::clear_override_and_reassign(
                            session, &sections, now,
                        );
                    }
                }
            }
        })
        .await
        .map_err(|e| e.to_string())
}

/// Background loop: refresh state from disk (other instances may write it),
/// detect agent states, and push the grouped session list to the frontend.
pub fn spawn_sessions_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut detector: Option<AgentStateDetector> = None;
        // Previous tick's agent state per session id, for unread detection.
        let mut prev_states: HashMap<String, String> = HashMap::new();
        loop {
            if let Ok(svc) = service().await {
                let detector = detector.get_or_insert_with(|| {
                    AgentStateDetector::new(
                        svc.session_manager().tmux.clone(),
                        Duration::from_millis(SESSIONS_REFRESH_MS / 2),
                    )
                });
                let _ = svc.store().reload_if_changed().await;
                // Config hot-reload, mirroring the TUI's check_config_reload:
                // picks up edits from another instance's settings UI or a
                // hand-edited config.toml. Backend consumers re-read config
                // every tick; the event lets the frontend refresh keybindings.
                if let Ok(true) = svc.reload_config() {
                    let _ = app.emit("config-updated", ());
                }
                let mut snapshot = build_snapshot(svc, Some(detector)).await;
                let groups = &mut snapshot.groups;

                // A Working → Idle transition marks the session unread (the
                // agent finished while the user wasn't watching), mirroring
                // the TUI. Sessions with an attached terminal are exempt.
                let mut newly_unread: Vec<claude_commander_core::session::SessionId> = Vec::new();
                for g in groups.iter_mut() {
                    for row in &mut g.sessions {
                        let became_idle = row.agent_state == "idle"
                            && prev_states.get(&row.id).map(String::as_str) == Some("working");
                        if became_idle && !crate::pty::is_attached(&app, &row.tmux_session_name) {
                            if let Ok(sid) = crate::service::parse_session_id(&row.id) {
                                row.unread = true;
                                newly_unread.push(sid);
                            }
                        }
                    }
                }
                if !newly_unread.is_empty() {
                    let _ = svc
                        .store()
                        .mutate(move |state| {
                            for sid in &newly_unread {
                                if let Some(s) = state.get_session_mut(sid) {
                                    s.unread = true;
                                }
                            }
                        })
                        .await;
                }
                prev_states = groups
                    .iter()
                    .flat_map(|g| &g.sessions)
                    .map(|r| (r.id.clone(), r.agent_state.clone()))
                    .collect();

                let _ = app.emit("sessions-updated", &snapshot);
            }
            tokio::time::sleep(Duration::from_millis(SESSIONS_REFRESH_MS)).await;
        }
    });
}
