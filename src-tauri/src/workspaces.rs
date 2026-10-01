//! Workspaces: the merged workspace list for the snapshot, and the commands
//! that edit definitions and move projects between workspaces.
//!
//! A workspace is a label on a project (`Project::workspace`, `None` = the
//! built-in Main); definitions, Main's label and the startup choice live in the
//! shared `config.toml`. The rules (naming, merging, startup resolution) are
//! upstream's - `claude-commander-protocol` and `claude-commander-viewmodel` -
//! so the GUI and the TUI cannot disagree about them.
//!
//! `set_workspace_defs` replaces the definition list wholesale, and the
//! frontend's snapshot can be a couple of seconds stale, so the frontend never
//! sends a full list: each command below builds its request from the *current*
//! config with the pure `*_request` helpers, which are what the tests cover.

use claude_commander_core::api::CommanderService;
use claude_commander_core::error::SessionError;
use claude_commander_core::Config;
use claude_commander_protocol::workspace::{
    validate_workspace_label, validate_workspace_name, SetWorkspacesRequest, StartupWorkspace,
    WorkspaceDef, WorkspaceRejection,
};
use claude_commander_viewmodel::workspace::{self as vm, MergedWorkspace, WorkspaceSource};
use serde::Serialize;

use crate::service::{parse_project_id, service};

/// One workspace in the snapshot's merged list. `name` is the identity
/// (`None` = Main, else the tag projects carry); `label` is what to display.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub name: Option<String>,
    pub label: String,
}

impl From<MergedWorkspace> for WorkspaceEntry {
    fn from(w: MergedWorkspace) -> Self {
        Self {
            name: w.name,
            label: w.label,
        }
    }
}

/// The merged workspace list, exactly as the TUI computes it: Main first, then
/// the configured definitions in order, then any tag a project carries that no
/// definition names (so no project is ever unreachable). `project_tags` is in
/// project display order.
pub fn merged_workspaces<'a>(
    config: &'a Config,
    project_tags: impl IntoIterator<Item = &'a str>,
) -> Vec<MergedWorkspace> {
    vm::merge_workspace_sources(&[WorkspaceSource {
        defs: &config.workspaces,
        main: config.main_workspace.as_ref(),
        project_tags: project_tags.into_iter().collect(),
    }])
}

/// The merged list from the service's current config and project tags.
async fn current_merged(svc: &CommanderService, config: &Config) -> Vec<MergedWorkspace> {
    let tags: Vec<String> = {
        let state = svc.store().read().await;
        // The snapshot's project order, so tag-only workspaces line up with it.
        crate::groups::projects_in_display_order(&state)
            .into_iter()
            .filter_map(|p| p.workspace.clone())
            .collect()
    };
    merged_workspaces(config, tags.iter().map(String::as_str))
}

/// The definition list for `wanted` names (in order) that this server will
/// accept: upstream's `definitions_for_server` keeps every name the config
/// already defines and drops a tag-only name that clashes case-insensitively
/// with one of them or with Main's label, so a stray tag can't make every edit
/// fail validation. Main's stored label counts only when valid, as in
/// `set_workspace_defs`, so a hand-broken label can't narrow anything out.
fn defs_for(config: &Config, wanted: &[WorkspaceDef]) -> Vec<WorkspaceDef> {
    let main_label = config
        .main_workspace
        .as_ref()
        .map(|m| m.name.as_str())
        .filter(|label| validate_workspace_label(label).is_ok());
    vm::definitions_for_server(wanted, &config.workspaces, main_label)
}

fn named_defs(merged: &[MergedWorkspace]) -> Vec<WorkspaceDef> {
    merged
        .iter()
        .filter_map(|w| w.name.clone().map(WorkspaceDef::named))
        .collect()
}

/// Append workspace `raw` (validated and trimmed) after every existing one.
/// Built from the merged list, like the TUI's create, so a workspace that only
/// existed as a project tag gains a definition and keeps its place. Returns the
/// request and the stored spelling of the new name.
pub fn create_request(
    config: &Config,
    merged: &[MergedWorkspace],
    raw: &str,
) -> Result<(SetWorkspacesRequest, String), WorkspaceRejection> {
    let name = validate_workspace_name(raw)?;
    // `defs_for` would silently drop a clashing new name, so refuse it here.
    if vm::workspace_name_taken(merged, &name, None) {
        return Err(WorkspaceRejection::Duplicate { name });
    }
    let mut wanted = named_defs(merged);
    wanted.push(WorkspaceDef::named(name.clone()));
    let req = SetWorkspacesRequest {
        workspaces: defs_for(config, &wanted),
        main: None,
        startup_workspace: None,
    };
    Ok((req, name))
}

/// Reorder the workspaces to follow `names`. Names the merged list doesn't
/// know (deleted since the caller's snapshot) are ignored; workspaces the
/// caller didn't mention (created since) keep their relative order, after the
/// ones it did. Main is never part of the order: it always comes first.
pub fn reorder_request(
    config: &Config,
    merged: &[MergedWorkspace],
    names: &[String],
) -> SetWorkspacesRequest {
    let current = named_defs(merged);
    let mut wanted: Vec<WorkspaceDef> = Vec::with_capacity(current.len());
    for name in names {
        if let Some(def) = current.iter().find(|d| &d.name == name) {
            if !wanted.contains(def) {
                wanted.push(def.clone());
            }
        }
    }
    for def in current {
        if !wanted.contains(&def) {
            wanted.push(def);
        }
    }
    SetWorkspacesRequest {
        workspaces: defs_for(config, &wanted),
        main: None,
        startup_workspace: None,
    }
}

/// Relabel the built-in Main workspace, leaving the definitions as they are.
/// Upstream validates the label (and refuses one that clashes with a name).
pub fn main_label_request(config: &Config, label: &str) -> SetWorkspacesRequest {
    SetWorkspacesRequest {
        workspaces: config.workspaces.clone(),
        main: Some(WorkspaceDef::named(label)),
        startup_workspace: None,
    }
}

/// Set the startup choice (`"last"`, `"main"` or a workspace name). A pinned
/// name must be defined, so one that is only a project tag gets a definition
/// appended - the same self-heal as moving a project, and what the TUI does.
/// The match is exact, like upstream's `ensure_workspace_defined`: a re-cased
/// spelling of an existing name is refused by validation ("defined twice")
/// rather than guessed at, so callers pass a name from the merged list.
pub fn startup_request(config: &Config, value: &str) -> SetWorkspacesRequest {
    let startup = StartupWorkspace::from(value.to_string());
    let mut workspaces = config.workspaces.clone();
    if let StartupWorkspace::Named(name) = &startup {
        let name = name.trim();
        if !workspaces.iter().any(|d| d.name == name) {
            workspaces.push(WorkspaceDef::named(name));
        }
    }
    SetWorkspacesRequest {
        workspaces,
        main: None,
        startup_workspace: Some(startup),
    }
}

/// Core reports a refused workspace name as `SessionError::InvalidName`, whose
/// Display reads "Session error: Invalid session name ..."; surface just the
/// rule that was broken (it ends up in a toast).
fn workspace_err(e: claude_commander_core::Error) -> String {
    match e {
        claude_commander_core::Error::Session(SessionError::InvalidName { reason, .. }) => reason,
        other => other.to_string(),
    }
}

fn apply(svc: &CommanderService, req: SetWorkspacesRequest) -> Result<(), String> {
    svc.set_workspace_defs(req).map_err(workspace_err)
}

/// Move a project into `workspace` (`None` = Main). An unknown name is
/// defined on the way, so "new workspace + move" is one call.
#[tauri::command]
pub async fn set_project_workspace(
    project_id: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let id = parse_project_id(&project_id)?;
    let svc = service().await?;
    svc.set_project_workspace(&id, workspace)
        .await
        .map_err(workspace_err)
}

/// Define a new workspace, appended last. Returns its stored (trimmed) name.
#[tauri::command]
pub async fn create_workspace(name: String) -> Result<String, String> {
    let svc = service().await?;
    let config = svc.read_config();
    let merged = current_merged(svc, &config).await;
    let (req, name) = create_request(&config, &merged, &name).map_err(|e| e.to_string())?;
    apply(svc, req)?;
    Ok(name)
}

/// Put the workspaces in the order of `names` (see [`reorder_request`]).
#[tauri::command]
pub async fn reorder_workspaces(names: Vec<String>) -> Result<(), String> {
    let svc = service().await?;
    let config = svc.read_config();
    let merged = current_merged(svc, &config).await;
    apply(svc, reorder_request(&config, &merged, &names))
}

/// Rename a workspace: its definition, a startup pin on it, and every project
/// tagged with it. `false` when no definition or tag had that name (it was
/// already renamed or deleted elsewhere).
#[tauri::command]
pub async fn rename_workspace(from: String, to: String) -> Result<bool, String> {
    let svc = service().await?;
    svc.rename_workspace(&from, &to)
        .await
        .map_err(workspace_err)
}

/// Delete a workspace and move its projects to Main (a startup pin on it
/// becomes Main). `false` when there was nothing by that name.
#[tauri::command]
pub async fn delete_workspace(name: String) -> Result<bool, String> {
    let svc = service().await?;
    svc.delete_workspace(&name).await.map_err(workspace_err)
}

/// Relabel the built-in Main workspace.
#[tauri::command]
pub async fn set_main_workspace_label(label: String) -> Result<(), String> {
    let svc = service().await?;
    apply(svc, main_label_request(&svc.read_config(), &label))
}

/// Set which workspace frontends open on: `"last"`, `"main"` or a name.
#[tauri::command]
pub async fn set_startup_workspace(value: String) -> Result<(), String> {
    let svc = service().await?;
    apply(svc, startup_request(&svc.read_config(), &value))
}

/// The workspace to open on at launch, given this client's last-used one
/// (`None` = Main or never set): upstream's resolution over the current
/// merged list, so a pinned or remembered workspace that no longer exists
/// falls back to Main (`None`).
#[tauri::command]
pub async fn resolve_startup_workspace(last: Option<String>) -> Result<Option<String>, String> {
    let svc = service().await?;
    let config = svc.read_config();
    let merged = current_merged(svc, &config).await;
    Ok(vm::resolve_startup_workspace(
        &config.startup_workspace,
        last.as_deref(),
        &merged,
    ))
}

#[cfg(test)]
mod tests {
    use claude_commander_protocol::workspace::validate_set_workspaces;

    use super::*;

    fn config(defs: &[&str], main: Option<&str>) -> Config {
        Config {
            workspaces: defs.iter().map(|d| WorkspaceDef::named(*d)).collect(),
            main_workspace: main.map(WorkspaceDef::named),
            ..Config::default()
        }
    }

    fn names(defs: &[WorkspaceDef]) -> Vec<&str> {
        defs.iter().map(|d| d.name.as_str()).collect()
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn merged_list_is_main_then_defs_then_undefined_tags() {
        let c = config(&["Work", "Play"], Some("Home"));
        let merged = merged_workspaces(&c, ["Lost", "Work", "Lost"]);
        let entries: Vec<WorkspaceEntry> = merged.into_iter().map(Into::into).collect();
        assert_eq!(
            entries,
            vec![
                WorkspaceEntry {
                    name: None,
                    label: "Home".into()
                },
                WorkspaceEntry {
                    name: Some("Work".into()),
                    label: "Work".into()
                },
                WorkspaceEntry {
                    name: Some("Play".into()),
                    label: "Play".into()
                },
                WorkspaceEntry {
                    name: Some("Lost".into()),
                    label: "Lost".into()
                },
            ]
        );
        assert_eq!(merged_workspaces(&Config::default(), [])[0].label, "Main");
    }

    #[test]
    fn create_appends_a_trimmed_name_last() {
        let c = config(&["Work"], None);
        let merged = merged_workspaces(&c, []);
        let (req, name) = create_request(&c, &merged, "  OSS ").unwrap();
        assert_eq!(name, "OSS");
        assert_eq!(names(&req.workspaces), ["Work", "OSS"]);
        assert_eq!(req.main, None, "Main's label is left alone");
        assert_eq!(req.startup_workspace, None);
    }

    #[test]
    fn create_defines_a_tag_only_workspace_in_place() {
        let c = config(&["Work"], None);
        let merged = merged_workspaces(&c, ["Lost"]);
        let (req, _) = create_request(&c, &merged, "OSS").unwrap();
        assert_eq!(names(&req.workspaces), ["Work", "Lost", "OSS"]);
    }

    #[test]
    fn create_refuses_invalid_and_taken_names() {
        let c = config(&["Work"], Some("Home"));
        let merged = merged_workspaces(&c, ["Lost"]);
        for (raw, want) in [
            ("work", "workspace \"work\" is defined twice"),
            (" HOME ", "workspace \"HOME\" is defined twice"),
            ("lost", "workspace \"lost\" is defined twice"),
            ("   ", "workspace name must not be empty"),
            ("Main", "\"Main\" is a reserved workspace name"),
            ("last", "\"last\" is a reserved workspace name"),
            ("a\tb", "workspace name must not contain control characters"),
        ] {
            let err = create_request(&c, &merged, raw).unwrap_err();
            assert_eq!(err.to_string(), want, "{raw:?}");
        }
        let long = "x".repeat(41);
        assert!(matches!(
            create_request(&c, &merged, &long),
            Err(WorkspaceRejection::TooLong { max: 40 })
        ));
        assert!(create_request(&c, &merged, &"x".repeat(40)).is_ok());
    }

    #[test]
    fn reorder_follows_the_given_names() {
        let c = config(&["A", "B", "C"], None);
        let merged = merged_workspaces(&c, []);
        let req = reorder_request(&c, &merged, &strings(&["C", "A", "B"]));
        assert_eq!(names(&req.workspaces), ["C", "A", "B"]);
        assert_eq!(req.main, None);
        assert_eq!(req.startup_workspace, None);
    }

    #[test]
    fn reorder_keeps_unmentioned_workspaces_and_ignores_unknown_ones() {
        // The caller's list is stale: "D" was created since, "Gone" deleted.
        let c = config(&["A", "B", "C", "D"], None);
        let merged = merged_workspaces(&c, []);
        let req = reorder_request(&c, &merged, &strings(&["C", "Gone", "A", "C"]));
        assert_eq!(names(&req.workspaces), ["C", "A", "B", "D"]);
    }

    #[test]
    fn reorder_can_place_a_tag_only_workspace() {
        let c = config(&["A"], None);
        let merged = merged_workspaces(&c, ["Lost"]);
        let req = reorder_request(&c, &merged, &strings(&["Lost", "A"]));
        assert_eq!(names(&req.workspaces), ["Lost", "A"]);
    }

    #[test]
    fn a_tag_clashing_with_a_definition_never_blocks_an_edit() {
        // "work" is a tag with no definition, "Work" is defined: the merged
        // list holds both, which no server accepts as one list.
        let c = config(&["Work"], None);
        let merged = merged_workspaces(&c, ["work"]);
        let req = reorder_request(&c, &merged, &strings(&["work", "Work"]));
        assert_eq!(names(&req.workspaces), ["Work"]);
        assert!(validate_set_workspaces(&req).is_ok());
        let (req, _) = create_request(&c, &merged, "OSS").unwrap();
        assert_eq!(names(&req.workspaces), ["Work", "OSS"]);
        assert!(validate_set_workspaces(&req).is_ok());
    }

    #[test]
    fn main_label_keeps_the_definitions() {
        let c = config(&["Work", "Play"], None);
        let req = main_label_request(&c, "Home");
        assert_eq!(names(&req.workspaces), ["Work", "Play"]);
        assert_eq!(req.main, Some(WorkspaceDef::named("Home")));
        assert_eq!(req.startup_workspace, None);
        // A clash with a name is upstream's to refuse.
        assert!(validate_set_workspaces(&main_label_request(&c, "work")).is_err());
    }

    #[test]
    fn startup_parses_the_three_forms() {
        let c = config(&["Work"], None);
        for (value, want) in [
            ("last", StartupWorkspace::Last),
            ("MAIN", StartupWorkspace::Main),
            ("Work", StartupWorkspace::Named("Work".into())),
        ] {
            let req = startup_request(&c, value);
            assert_eq!(req.startup_workspace, Some(want), "{value}");
            assert_eq!(names(&req.workspaces), ["Work"]);
            assert!(validate_set_workspaces(&req).is_ok());
        }
    }

    #[test]
    fn startup_pinning_an_undefined_name_defines_it() {
        let c = config(&["Work"], None);
        let req = startup_request(&c, "Lost");
        assert_eq!(names(&req.workspaces), ["Work", "Lost"]);
        assert!(validate_set_workspaces(&req).is_ok());
    }

    #[test]
    fn invalid_name_errors_drop_the_session_wording() {
        let e: claude_commander_core::Error = SessionError::InvalidName {
            name: "x".into(),
            reason: "workspace name must not be empty".into(),
        }
        .into();
        assert_eq!(workspace_err(e), "workspace name must not be empty");
    }
}
