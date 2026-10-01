# Handoff: Workspaces in CC-GUI

## Overview
claude-commander now has **workspaces**. This handoff adds them to CC-GUI's **Console** and **Board** views, using a **title-bar switcher**. Management flows: move a project to a workspace (context menu or drag), create/rename/delete workspaces, theme per workspace, and a startup-workspace setting.

How workspaces work upstream (claude-commander protocol/core, the source of truth):
- A workspace is a **label on a project**. Untagged projects belong to the built-in **Main** workspace.
- Workspaces are defined on first use. "New workspace…" plus a move creates one in a single step.
- Switching is a **client-side hard filter**. Only the active workspace's projects and sessions are visible. Sessions in other workspaces keep running.
- Startup workspace: `last` | `main` | a named workspace. If a named workspace is gone, fall back to Main.
- Names are at most 40 characters. `main` and `last` are reserved.
- Themes per workspace are stored by each frontend, keyed by workspace name (like the TUI's `[workspace_themes]`).

## About the design files
The files in this bundle are **design references built in HTML**. They are not production code. Recreate them in CC-GUI's existing environment (vanilla TS modules + `src/style.css`, Tauri), following its patterns: `src/chrome/titlebar.ts`, `src/sidebar/*`, `src/board/*`, `src/menu.ts`, `src/settings/*`, `src/theme/palettes.ts`. Use the existing CSS classes and tokens (`--bg-elevated`, `--border-strong`, `--accent`, …) rather than the mock's inline styles.

## Fidelity
**High fidelity.** The mocks are built from CC-GUI's real `src/style.css` values and its Catppuccin Mocha / Tokyo Night palettes. New elements reuse existing component styles; each one notes the style it borrows.

## Screens / views

### 1a: Title-bar workspace chip (Console + Board)
- **Placement:** in the title bar's left cluster, after the `claude-commander` name and before the session-count pill.
- **Chip:** height 28px, padding `0 8px 0 10px`, 1px `--border`, radius 7px, transparent background. Text is 12px/500 `--text`, followed by a `▾` caret at 10px `--text-dim` with a 6px gap.
  - Hover/open: border `--border-strong`, background `--border`.
  - Drag-over target: border `--accent`, background `color-mix(--accent 18%)`.
- **Hidden** when only Main exists, which keeps today's chrome unchanged.
- **Scoping:** these all filter to the active workspace:
  - the session-count pill (`N sessions · N live`) and the `N waiting on you` pill
  - the sidebar project groups (every group-by mode)
  - the terminal tab strip
  - the Board columns and the "All projects" filter dropdown
  - the Board dock
- **Other workspaces:** no badges or attention counts from them (explicit product decision).
- **Keyboard:** ⌘⇧1–9 jumps to workspace N (⌘1–9 is taken by terminal tabs). ⌘K gets "Switch workspace: <name>" commands.

### Workspace menu (chip open)
- Reuses `.context-menu`: `--bg-elevated`, 1px `--border-strong`, radius 12px, padding 4px, shadow `0 8px 24px rgba(0,0,0,.28)`, item padding `6px 10px`, item radius 7px, 12px text. Min-width 250px, anchored 6px below the chip.
- **Header:** "WORKSPACES" in 11px/600, uppercase, letter-spacing .05em, `--text-dim`.
- **Rows:** `✓` (in `--accent`, 12px column) on the active row, then the name, then `N projects` (11px `--text-dim`), then the shortcut `⌘⇧N` right-aligned (11px `--text-dim`). Hover background is `--border`.
- **Below a separator:** "New workspace…" and "Manage workspaces…" (the second opens Settings › Workspaces).

### 1c: Move project to workspace
- **Context menu:** a new "Move to workspace ▸" item on the project-header context menu (`src/sidebar/menus.ts`), between "Project shell" and the destructive "Remove project" item, with separators.
- **Submenu:** every workspace; the current one is ticked, dimmed and tagged "current". "New workspace…" sits under a separator and prompts for a name, then moves the project.
- **Drag:** drag a project header onto the title-bar chip. The chip shows the drag-over state and the workspace menu opens. Hovering a row highlights it, and dropping moves the project.
  - The source header drops to 50% opacity.
  - The drag ghost is a mini header (color swatch + NAME + "→ move to OSS") with a 1px `--accent` border.
- **After a move:** the project leaves the current view, and the toast can offer "Switch to OSS".

### 1d: Settings › Workspaces
- **Nav:** a new "Workspaces" entry in the settings nav, after "Sections".
- **Help text** (11px `--text-dim`): "A workspace is a label on a project. Switching filters the Console and Board to that workspace's projects; sessions elsewhere keep running. Deleting a workspace moves its projects to Main."
- **List:** 1px `--border`, radius 10px. Rows have padding 8px 10px and a gap of 10px, and contain, in order:
  - a drag handle (⋮⋮) for reorder (this order is the menu and shortcut order)
  - the name (12.5px/500)
  - a "built-in" tag on Main only
  - `N projects` in mono 11px `--text-dim`
  - a theme select (150px; "Global theme" or any palette)
  - rename ✎ (inline input with an `--accent` focus ring)
  - delete ✕ (hidden for Main)
- **Add row:** an input "New workspace name" plus a "＋ Add" button.
- **Open on launch:** a select with "Last used" / "Main" / each named workspace.
- **Main label:** a text field (display name of the built-in workspace).

### 1e: Delete workspace
- Reuses the `.confirm-overlay` dialog, 380px wide. Copy:
  > Delete workspace "OSS"?
  > Its 2 projects (dotfiles, ratatui-widgets) move to Main. No sessions are stopped.
- Buttons: "Cancel", plus "Delete" with a `--danger` border and text.

### 1f: Theme per workspace
- When the active workspace has its own theme, apply that palette's CSS variables on switch: chrome, terminal and diffs.
- "Global theme" means inherit the app theme.
- The mock shows OSS set to Tokyo Night in both Console and Board.

## State
- `workspaces: {name, order}[]` comes from the server. `project.workspace: string | null` (null = Main).
- `activeWorkspace: string` persists locally, and is chosen at startup from the `openOnLaunch` setting.
- `workspaceThemes: Record<name, themeId>` and `mainLabel: string` are local settings.
- Each workspace remembers its own open tabs and selected session, and restores them on switch (assumption to confirm).
- Selectors: `visibleProjects = projects.filter(p => (p.workspace ?? 'Main') === activeWorkspace)`; every view, count, pill, tab and board column derives from this.

## Design tokens
Use the existing tokens from `src/style.css` and `src/theme/palettes.ts`. Mocha values used in the mock:
- **Backgrounds:** `--bg-base` #1e1e2e, `--bg-elevated` #191926, `--bg-inset` #11111b
- **Borders:** `--border` #343650, `--border-strong` #4a4c68
- **Text:** `--text` #e4e8fb, `--text-muted` #b7bedd, `--text-dim` #8a90ad
- **Accents and status:** `--accent` #8fb8ff, `--info` #cba6f7, `--success` #a9e6a4, `--warning` #f6dd9c, `--danger` #f58fab
- **Fonts:** IBM Plex Sans (UI) and IBM Plex Mono (counts, shortcuts, branches). The fonts are included under `src/assets/fonts`.

## Files
- `Workspaces.dc.html`: the canvas with every state (1a, 1c–1f, plus the baselines 0a/0b). Open it in a browser.
- `CCFrame.dc.html`: the parameterised CC-GUI frame. Props: `view` (console|board), `switcher` (none|titlebar), `ws`, `overlay` (none|wsMenu|projMenu|drag|settings|delete), `theme` (mocha|tokyo). The mock data and filtering logic are in its script. Its `sidebar` switcher mode is a discarded exploration; ignore it.
- `support.js`: runtime needed to open the `.dc.html` files.
- `src/assets/fonts/*`: the fonts the mocks use.
