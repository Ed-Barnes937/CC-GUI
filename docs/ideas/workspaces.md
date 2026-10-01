# Idea: workspaces (scope the GUI to a named group of projects)

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.37.0** (upstream #319).

## What this is

A workspace is a label on a project (`Project::workspace`, `None` = the
built-in **Main**). Switching workspace is a client-side filter: every
workspace shares the same `state.json` and background loops, and the sidebar
and board show only the active workspace's projects and sessions. The TUI
ships this (switcher, status-bar chips, waiting hints, per-workspace themes);
CC-GUI shows every project regardless of tag.

This is a CC feature to adopt, not GUI parity to rebuild: storage, mutations
and every frontend decision live in the shared crates. CC-GUI owns only the
active-workspace state, the filter wiring and the UI. Because tags live in CC's
files, a project moved in the TUI lands in the same workspace in the GUI.

## The library surface

Mutations - `claude_commander_core::api::CommanderService`:

- `set_workspace_defs(SetWorkspacesRequest)` - replace the definition list
  (create / reorder; array order is display order). Never re-tags projects.
- `rename_workspace(from, to) -> bool` - renames the definition and re-tags
  every project carrying `from`.
- `delete_workspace(name) -> bool` - drops the definition, moves its projects
  to Main (a startup pin on it becomes Main).
- `set_project_workspace(id, Option<String>)` - move one project; an undefined
  name is defined on the way (self-heal).
- `add_project` / `scan_directory` / `ensure_project` take a
  `workspace: Option<String>` for new projects (the GUI passes `None` today).

Stored data: `Project::workspace` in `state.json`; `workspaces`,
`main_workspace` (Main's label) and `startup_workspace` (`last` / `main` /
`<name>`) in `config.toml`. `Snapshot` carries `workspaces`, `main_workspace`
and `startup_workspace`; validation lives in
`claude_commander_protocol::workspace` (`validate_workspace_name`, ...).

Decisions - `claude_commander_viewmodel::workspace` (shared with the TUI and
Flutter app so the same fleet looks the same everywhere; already in
`Cargo.lock` via core, needs a direct dependency):

- `merge_workspaces` - the ordered list, Main first; undefined tags still get
  an entry so no project becomes unreachable.
- `workspaces_visible` - show workspace UI only once 2+ workspaces exist.
- `in_workspace` / `projects_in_workspace` / `sessions_in_workspace` - what
  "in this workspace" means.
- `waiting_counts` / `waiting_elsewhere` - "N waiting in other workspaces".
- startup resolution for `startup_workspace`, given the client's remembered
  last workspace.

## GUI integration

- Active workspace: GUI-owned state plus a remembered "last" (the TUI keeps
  its own in `tui.json`; ours belongs in the GUI prefs alongside the theme
  keys), resolved against `startup_workspace` at boot.
- Scoping: filter the snapshot to the active workspace before
  `build_sections` in `src-tauri/src/groups.rs` (as the TUI's `scope` does),
  and the board's equivalent. Switching re-renders, no backend reload.
- Thin commands (new `src-tauri/src/workspaces.rs` or in `projects.rs`)
  delegating to the five mutations; add-project / scan pass the active
  workspace.
- UI, hidden until `workspaces_visible`: a switcher in the titlebar and
  palette (`src/chrome/titlebar.ts`, `src/palette.ts`, `src/commands.ts`),
  create/rename/delete, "Move to workspace…" on the project context menu,
  and `waiting_elsewhere` folded into the attention pills
  (`src/chrome/attention.ts`).
- Keybindings: CC defines `NextWorkspace` / `PreviousWorkspace` /
  `WorkspacePicker` / `NewWorkspace` / `MoveProjectToWorkspace` actions;
  binding them in the GUI's `KEY_ACTIONS` reuses the user's configured keys.
  Update `src/help.ts` and the README keyboard table.
- Per-workspace themes are the one genuinely GUI-owned piece: CC's
  `workspace_themes` are TUI themes, so key our own theme prefs by workspace
  name if we want them.

## Verification (when implemented)

- Unit: the snapshot filter and active-workspace resolution (fakes, not mocks).
- iwft: seed two tagged projects, switch workspace, assert the sidebar and
  board show only the active one's sessions; move a project and assert it
  follows; delete a workspace and assert its projects land in Main.
