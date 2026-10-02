# Workspaces

## Goal

Bring claude-commander's **workspaces** (new in the v0.38.0 line, adopted in
#133) to CC-GUI's Console and Board views: a title-bar switcher that hard-filters
everything to the active workspace, moving projects between workspaces (context
menu or drag), create / rename / reorder / delete, a theme per workspace, and the
startup-workspace choice.

Design reference: [`docs/workspaces/design_handoff_workspaces/`](../docs/workspaces/design_handoff_workspaces/README.md)
(open `Workspaces.dc.html` in a browser for every state). The handoff is high
fidelity; this plan covers how to build it on the real upstream contract, and
where that contract overrides the handoff.

Idea doc: `docs/ideas/workspaces.md` (captured in the v0.37.0/v0.38.0 bump;
deleted in PR 6, as it asked, and still in git history). This plan follows it
except where noted under "Where this plan departs from the idea doc".

## Upstream contract (the source of truth)

From `claude-commander-protocol::workspace`, `claude-commander-core::api` and
`claude-commander-viewmodel::workspace` at the pinned v0.38.0:

- A workspace is a **label on a project**: `Project::workspace: Option<String>`,
  `None` = built-in **Main**. One state file, one server, one set of loops.
- **Definitions** live in the shared `config.toml` as `[[workspaces]]`
  (`WorkspaceDef { name }`, array order = display order), plus
  `main_workspace: Option<WorkspaceDef>` (Main's display label only) and
  `startup_workspace = "last" | "main" | "<name>"`.
- Service methods:
  - `set_workspace_defs(SetWorkspacesRequest { workspaces, main?, startup_workspace? })`:
    wholesale replace, validated; never re-tags projects.
  - `rename_workspace(from, to)`: def + startup pin + the TUI's
    `[workspace_themes]` entry + every project tag.
  - `delete_workspace(name)`: drops def + TUI theme, moves projects to Main.
  - `set_project_workspace(id, Option<name>)`: auto-defines an unknown name, so
    "New workspace… + move" is one call.
  - `add_project(path, workspace)` / `scan_directory(dir, workspace)`: new
    projects land in the caller's workspace. CC-GUI currently passes `None`
    (`src-tauri/src/projects.rs:13`, `:48`).
- Naming rules (`validate_workspace_name`): trimmed, non-empty, at most 40
  chars, no control chars, not `last`/`main` (case-insensitive), no
  case-insensitive duplicates (Main's label included).
- `merge_workspace_sources` (viewmodel): Main first, then defs in order, then
  any tag used by a project but defined nowhere, so no project is ever
  unreachable. `workspaces_visible` = at least 2 workspaces.
- "Last used" is a **per-client** pref (the TUI keeps `last_workspace` in its
  private prefs), so CC-GUI keeps its own.
- Per-workspace **themes are per-frontend**. The config's `[workspace_themes]`
  is the TUI's (ratatui colour presets), not ours.

### Where the contract overrides the handoff

| Handoff says | Upstream reality | Plan |
|---|---|---|
| `openOnLaunch` is a local setting | `startup_workspace` is shared config | Read/write the shared config, so the TUI and GUI agree |
| `mainLabel` is a local setting | `main_workspace` is shared config | Same: shared config |
| `workspaces: {name, order}[]` | `WorkspaceDef` is just `{ name }`, order is array order | Order = array position |
| Themes stored per frontend | Same, but core's rename/delete only maintains the TUI's map | GUI renames/drops its own localStorage entry after a successful rename/delete |

### Where this plan departs from the idea doc

| Idea doc says | Plan | Why |
|---|---|---|
| Filter in the backend before `build_sections` (like the TUI's `scope`) | Filter in the frontend store, including section bucket ids | The active workspace is GUI-owned (localStorage) and switching must not need a backend round-trip. `build_sections` returns every bucket (empty ones included) and orders within a bucket by per-session timestamp, so dropping ids afterwards gives the same result as filtering first |
| Fold `waiting_elsewhere` into the attention pills | No signals from other workspaces | The handoff, which is newer, decided this explicitly. Kept as open question 3 |

## Key decisions

1. **Scope at the store, not per view.** `app/store.ts` keeps the full snapshot
   and exposes `groups()` as the **active workspace's** groups; a new
   `allGroups()` serves the few callers that must see everything. Every view,
   count and pill (15 files call `groups()` today) becomes scoped for free, and a
   future view cannot forget to filter. Each call site is audited once in PR 2
   to confirm which of the two it wants. This mirrors the handoff's
   `visibleProjects` selector and viewmodel's `projects_in_workspace`. Section
   buckets (`sections()`) are filtered to the active workspace's session ids in
   the same place.
2. **Merge in the backend with the viewmodel crate.** Add
   `claude-commander-viewmodel` (same git tag; serde-only, light) and compute
   the merged list with `merge_workspace_sources` so untagged-but-used
   workspaces appear exactly as they do in the TUI. CC-GUI's snapshot is not the
   protocol `Snapshot`, so build a `WorkspaceSource` by hand from
   `read_config()` + project tags.
3. **Workspace edits apply immediately**, through dedicated commands, never
   through the Settings modal's working-copy save. Rename and delete must go
   through their own service methods anyway (they re-tag projects), and this
   matches the TUI.
4. **Wholesale-replace safety.** `set_workspace_defs` replaces the list, and the
   GUI's snapshot can be about 2s stale, so the frontend never sends a full list.
   The backend commands build it from the current config:
   `create_workspace(name)` appends, `reorder_workspaces(names)` reorders the
   current defs by the given names (unknown current defs keep their place at
   the end). That logic lives in a small tested helper, not in the handlers.
5. **Fix the `save_config` clobber.** `save_config` replaces the whole config
   with the modal's round-tripped copy (`src-tauri/src/settings.rs:24`), so a
   save after any workspace change made since the modal opened (by the GUI or
   the TUI) would silently restore stale `workspaces`, `main_workspace`,
   `startup_workspace` and `workspace_themes`. Before writing, copy those four
   fields from the current config. (Worth an upstream follow-up for a
   field-preserving `update_config`; the read-then-write window is tiny.)
6. **Hidden until a second workspace exists** (`workspaces_visible`), so
   today's chrome is unchanged for everyone who never uses the feature. Not an
   optional-feature registry entry (ADR-0008): it is a core concept with a
   zero-cost off state.
7. **No signals from other workspaces** (handoff's explicit product decision),
   even though viewmodel offers `waiting_elsewhere` and the TUI shows it. Easy to
   revisit later, since the data is in the snapshot.
8. **Per-workspace view memory.** Each workspace remembers its selected session
   and active terminal tab, restored on switch (the handoff's open assumption;
   recommended yes). xterm instances and PTYs for hidden workspaces **stay
   alive**: the tab strip only shows tabs whose session (or project shell) is in
   the active workspace, so switching back is instant and nothing reconnects.
   The commander tab is global.
9. **Theme override = one palette per workspace**, regardless of light/dark
   mode ("Global theme" = inherit). `resolveTheme()` consults the active
   workspace's override first, so chrome, xterm and Shiki all follow through the
   existing `onThemeChange` path.

## State

Backend snapshot additions (`src-tauri/src/groups.rs`):

```rust
pub struct WorkspaceEntry { pub name: Option<String>, pub label: String } // None = Main
// Snapshot
pub workspaces: Vec<WorkspaceEntry>,   // merged, Main first, display order
pub startup_workspace: String,         // "last" | "main" | name
// ProjectGroup
pub workspace: Option<String>,
```

Frontend, a new pure module `src/app/workspaces.ts` (Tauri-free, unit-tested):

- `activeWorkspace(): string | null` (null = Main), persisted as
  `cc-active-workspace` in localStorage (the GUI's "last used").
- Startup resolution is **not** reimplemented in TS: at boot the frontend calls
  `resolve_startup_workspace(last_used)`, which delegates to viewmodel's
  `resolve_startup_workspace` (`last` → last used, `main` → Main, a name → that
  name, anything missing → Main), so the GUI and TUI cannot disagree.
- `inWorkspace(group, active)`, `projectCount(name)`, ordering for ⌘⇧N.
- `validateWorkspaceName(raw, existing)`: the protocol rules, for inline
  feedback before invoke. The backend re-validates; its error goes to a toast.
- Reconciliation on every snapshot: if the active workspace has vanished
  (deleted from the TUI, say), fall back to Main.
- `cc-workspace-themes`: `Record<name | "\u0000main", themeId>` (a key no user
  workspace can take, like core's reserved Main key), plus per-workspace view
  memory `cc-workspace-view`.

Switching = set the active workspace, save the old one's view memory, restore
the new one's, `requestRender` everything, re-resolve the theme.

## Backend commands (`src-tauri/src/workspaces.rs`, new)

Thin handlers over the service; list-building logic in a tested helper.

| Command | Calls |
|---|---|
| `set_project_workspace(project_id, workspace)` | `set_project_workspace` (auto-defines) |
| `create_workspace(name)` | current defs + `name` → `set_workspace_defs` |
| `reorder_workspaces(names)` | current defs reordered → `set_workspace_defs` |
| `rename_workspace(from, to)` | `rename_workspace` |
| `delete_workspace(name)` | `delete_workspace` |
| `set_main_workspace_label(label)` | `set_workspace_defs` with current defs + `main` |
| `set_startup_workspace(value)` | `set_workspace_defs` with current defs + `startup_workspace` |
| `resolve_startup_workspace(last)` | viewmodel `resolve_startup_workspace` over the merged list |

Plus: `add_project` / `scan_directory` take an optional `workspace` and the
frontend passes the active one. Each mutation emits a fresh snapshot, as other
mutations do.

## Delivery: stacked PRs

Each PR leaves the app shippable. `npm run typecheck`, unit tests, iwft,
`cargo fmt`/`clippy` green on each.

### PR 1: backend plumbing (no visible change)

- Add the `claude-commander-viewmodel` dependency; `workspaces` +
  `startup_workspace` on `Snapshot`, `workspace` on `ProjectGroup`.
- `workspaces.rs` commands above, registered in `main.rs`; `projects.rs` takes
  a workspace.
- `save_config` preservation fix (decision 5), with a Rust test that a stale
  save keeps the current workspace fields.
- Rust unit tests for the create/reorder list-building helper.
- Frontend `types.ts` mirrors; `TauriSimulator` gains workspace state and the
  new commands, and the seed can tag projects.

### PR 2: scoping + title-bar switcher (handoff 1a + menu)

- `app/workspaces.ts` (+ unit tests); `store.ts` split into
  `groups()` (scoped) and `allGroups()`; audit all 15 call sites.
- Scoped surfaces: session-count and attention pills, sidebar (every group-by
  mode), terminal tab strip, Board columns, "All projects" filter, Board dock,
  the new-session project picker, the palette's session list.
- Title-bar chip in `chrome/titlebar.ts` (after the app name, before the count
  pill) and its menu on `.context-menu`: WORKSPACES header, ✓ active row,
  `N projects`, `⌘⇧N`, then "New workspace…" (name prompt →
  `create_workspace` → switch) and "Manage workspaces…".
- Per-workspace view memory (decision 8); selection cleared when the selected
  session's project leaves the active workspace.
- Keys: ⌘⇧1–9 hard-wired next to ⌘1–9 in `commands.ts`; `KEY_ACTIONS` entries
  for next/previous workspace, switch-workspace picker and new workspace, using
  upstream's action names (`next_workspace`, `previous_workspace`,
  `workspace_picker`, `new_workspace`) so a configured binding carries over; ⌘K
  gets "Switch workspace: <name>". Update `HELP_SECTIONS` in `src/help.ts` and
  the README keyboard table.
- iwft: chip hidden with only Main; switching filters sidebar/board/tabs/pills;
  the startup choice is honoured; a vanished workspace falls back to Main.

### PR 3: moving projects (handoff 1c)

- "Move to workspace ▸" submenu on the project header menu
  (`src/sidebar/menus.ts`), between "Project shell" and "Remove project", with
  current ticked, dimmed and tagged; "New workspace…" prompts, then
  `set_project_workspace` with the new name (one call). Also the
  `move_project_to_workspace` key action.
- Drag a project header onto the chip with the shared `drag.ts` gesture: the
  source goes to 50% opacity, a mini-header ghost appears ("→ move to OSS"),
  the chip shows its drag-over state and opens the menu, hovered rows highlight,
  and a drop moves the project.
- After a move: the project leaves the view; the toast offers "Switch to <name>".
- New projects (add / scan) land in the active workspace.
- iwft for both paths and the toast action.

### PR 4: Settings › Workspaces + delete (handoff 1d, 1e)

- A custom settings tab after "Sections" (`settings/`, beside
  `sections.ts`): help text; list rows with the ⋮⋮ reorder handle
  (`reorder_workspaces`), name, "built-in" tag on Main, `N projects`, theme
  select (wired in PR 5; hidden until then), inline rename ✎, delete ✕ (not on
  Main); add row; "Open on launch" select (`set_startup_workspace`); Main label
  field (`set_main_workspace_label`). Every control applies immediately.
- Delete confirm on the existing `.confirm-overlay` (`toast.ts`), 380px, copy
  as in the handoff, listing the projects that move to Main. Deleting the
  active workspace switches to Main first.
- Renaming the active workspace keeps it active under the new name; rename and
  delete move or drop the GUI's own theme and view-memory entries.
- iwft for add / rename / reorder / delete / startup / Main label, including a
  rejected name surfacing the backend's message.

### PR 5: theme per workspace (handoff 1f)

- `theme/index.ts`: per-workspace override map, consulted by `resolveTheme()`;
  switching workspaces calls the existing apply path, so chrome, xterm and
  Shiki follow. The theme modal edits the global theme; while an override is
  active it says so ("OSS uses Tokyo Night · Manage").
- No-flash boot: `applyTheme` already caches the applied vars that the
  `vite.config.ts` boot plugin reads, so a relaunch into the same workspace
  ("Last used") paints correctly. A fixed startup workspace with a different
  theme may flash once; acceptable, noted in `docs/theming.md`.
- Settings row theme select ("Global theme" + all palettes, custom included).
- Unit tests for resolution; iwft that switching applies and reverts the theme.

### PR 6: docs

- `docs/theming.md` (per-workspace overrides), README feature list, and
  CLAUDE.md's frontend map (`app/workspaces.ts`, `src-tauri/src/workspaces.rs`).
- An ADR for "scope at the store" (decision 1), since it changes what
  `groups()` means for every future view.
- Delete `docs/ideas/workspaces.md`.

## Open questions (recommendations in brackets)

1. Startup choice and Main label as shared config rather than local, which
   departs from the handoff? [Yes: one answer across TUI and GUI.]
2. Per-workspace tab and selection memory? [Yes, with xterms kept alive.]
3. No "waiting in other workspaces" hint at all, unlike the TUI's status bar
   and the idea doc? [Keep the handoff's decision for v1; if it's wanted
   later, viewmodel's `waiting_elsewhere` is a small addition to the attention
   pill.]
4. One theme per workspace, ignoring light/dark mode? [Yes for v1; a
   light/dark pair is an easy extension of the map's value.]
