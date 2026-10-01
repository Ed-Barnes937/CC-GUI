//! Settings: expose the claude-commander `Config` as JSON for a generic
//! settings form, and write changes back through `update_config`.

use claude_commander_core::Config;

use crate::service::service;

#[tauri::command]
pub async fn get_config() -> Result<serde_json::Value, String> {
    let svc = service().await?;
    serde_json::to_value(svc.read_config()).map_err(|e| e.to_string())
}

/// The keybinding table from the claude-commander config, as
/// `{ action_name: ["k", "Ctrl-p", ...] }` (the same serialization as the
/// `[keybindings]` TOML section). The frontend maps these onto GUI actions.
#[tauri::command]
pub async fn get_keybindings() -> Result<serde_json::Value, String> {
    let svc = service().await?;
    serde_json::to_value(svc.read_config().keybindings).map_err(|e| e.to_string())
}

/// Replace the full config with the given JSON (the frontend round-trips the
/// object from `get_config`), except for the workspace fields - see
/// [`config_to_save`]. Returns whether a restart is required for some changes
/// to take effect.
#[tauri::command]
pub async fn save_config(config: serde_json::Value) -> Result<bool, String> {
    let svc = service().await?;
    let parsed = config_to_save(config, &svc.read_config())?;
    svc.update_config(parsed).map_err(|e| e.to_string())?;
    Ok(svc.restart_required())
}

/// Parse the settings form's config, keeping `current`'s workspace fields.
///
/// The form round-trips the whole config it loaded when it opened, but
/// workspaces are edited elsewhere - through their own commands, which apply
/// immediately, or by the TUI - so the form's copy of them can be stale. A
/// plain replace would silently undo every workspace change made while the
/// form was open, so `workspaces`, `main_workspace`, `startup_workspace` and
/// the TUI's `workspace_themes` always come from the current config.
pub fn config_to_save(form: serde_json::Value, current: &Config) -> Result<Config, String> {
    let mut parsed: Config =
        serde_json::from_value(form).map_err(|e| format!("invalid config: {e}"))?;
    parsed.workspaces = current.workspaces.clone();
    parsed.main_workspace = current.main_workspace.clone();
    parsed.startup_workspace = current.startup_workspace.clone();
    parsed.workspace_themes = current.workspace_themes.clone();
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use claude_commander_core::config::ThemeOverrides;
    use claude_commander_protocol::workspace::{StartupWorkspace, WorkspaceDef};

    use super::*;

    /// The form opened before any workspace existed; meanwhile a workspace was
    /// created, Main relabelled, a startup pin set and a TUI theme added. A
    /// save from that stale form keeps all four, and still applies its own
    /// edit.
    #[test]
    fn a_stale_form_save_keeps_the_current_workspace_fields() {
        let opened = Config::default();
        let mut form = serde_json::to_value(&opened).unwrap();
        let edited = !opened.ai_summary_enabled;
        form["ai_summary_enabled"] = serde_json::Value::Bool(edited);

        let mut current = Config {
            workspaces: vec![WorkspaceDef::named("Work"), WorkspaceDef::named("OSS")],
            main_workspace: Some(WorkspaceDef::named("Home")),
            startup_workspace: StartupWorkspace::Named("Work".into()),
            ..Config::default()
        };
        current
            .workspace_themes
            .insert("Work".into(), ThemeOverrides::default());

        let saved = config_to_save(form, &current).unwrap();
        assert_eq!(saved.workspaces, current.workspaces);
        assert_eq!(saved.main_workspace, current.main_workspace);
        assert_eq!(saved.startup_workspace, current.startup_workspace);
        assert_eq!(
            saved.workspace_themes.keys().collect::<Vec<_>>(),
            ["Work"],
            "the TUI's per-workspace themes survive"
        );
        assert_eq!(saved.ai_summary_enabled, edited, "the form's edit applies");
    }

    /// And the reverse: a form that carries workspace fields (stale, or edited
    /// by hand) can't overwrite them - they're never the form's to change.
    #[test]
    fn a_form_cannot_overwrite_the_workspace_fields() {
        let stale = Config {
            workspaces: vec![WorkspaceDef::named("Old")],
            startup_workspace: StartupWorkspace::Named("Old".into()),
            ..Config::default()
        };
        let form = serde_json::to_value(&stale).unwrap();
        let saved = config_to_save(form, &Config::default()).unwrap();
        assert!(saved.workspaces.is_empty());
        assert_eq!(saved.startup_workspace, StartupWorkspace::Last);
    }

    #[test]
    fn an_unparseable_form_is_refused() {
        let err = config_to_save(serde_json::json!("nope"), &Config::default()).unwrap_err();
        assert!(err.starts_with("invalid config:"), "{err}");
    }
}
