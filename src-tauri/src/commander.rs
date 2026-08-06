//! The persistent project-less commander session (config-gated).

use crate::service::{service, with_service};

/// CLI reference embedded in the commander's `CLAUDE.md`. Upstream v0.32.0
/// (PR #256) dropped `clap` from `claude-commander-core` and moved the
/// auto-generated reference into the CLI binary crate, which the GUI does not
/// embed. Rather than vendor the clap command tree (and keep it in sync every
/// release), point the commander at the live `--help`; the handwritten preamble
/// already explains what the CLI is for.
const CLI_REFERENCE: &str = "\
## CLI reference

Run `claude-commander --help`, or `claude-commander <command> --help`, for the \
current list of commands and their options.
";

/// Ensure the commander tmux session exists (creating or reviving it, and
/// refreshing its CLAUDE.md scaffold) and return its tmux session name.
/// Errors with the library's CommanderDisabled message when the config gate
/// is off.
#[tauri::command]
pub async fn prepare_commander() -> Result<String, String> {
    with_service(move |svc| async move {
        let config = svc.read_config();
        claude_commander_core::commander::ensure_session(
            &config,
            &svc.session_manager().tmux,
            CLI_REFERENCE,
        )
        .await
        .map_err(|e| e.to_string())
    })
    .await
}

/// Commander chip state for the sidebar footer.
#[derive(serde::Serialize, Clone)]
pub struct CommanderStatus {
    pub enabled: bool,
    pub running: bool,
}

pub async fn commander_status() -> CommanderStatus {
    match service().await {
        Ok(svc) => {
            let enabled = svc.read_config().commander_enabled;
            let running = if enabled {
                claude_commander_core::commander::is_running(&svc.session_manager().tmux).await
            } else {
                false
            };
            CommanderStatus { enabled, running }
        }
        Err(_) => CommanderStatus {
            enabled: false,
            running: false,
        },
    }
}
