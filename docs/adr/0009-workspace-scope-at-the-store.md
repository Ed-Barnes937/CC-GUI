# ADR-0009: Scope workspaces at the store, not per view

Date: 2026-10-02
Status: accepted

## Context

claude-commander v0.38.0 added workspaces: a workspace is a label on a project
(`Project::workspace`, `None` = the built-in Main), and switching one is a
client-side filter. Every workspace shares one state file, one server and one
set of background loops, and the GUI keeps its own active workspace (upstream
treats "last used" as a per-client preference), in localStorage.

Switching is a hard filter: the sidebar in every group-by mode, the Board, the
terminal tab strip, the session-count and attention pills, the "All projects"
filter, the new-session picker and the palette all show only the active
workspace. When this landed, 15 files read the snapshot through
`groups()` in `src/app/store.ts`.

Three places could apply the filter:

- **Each view.** Every caller filters what it reads. Fifteen call sites to
  get right now, and every future view, count or pill has to remember to as
  well. Forgetting fails quietly: a pill counting sessions from a hidden
  workspace looks plausible.
- **The backend**, before `build_sections`, as the TUI's `scope` does. But the
  active workspace is GUI-owned, so the backend would need it pushed to it,
  and a switch would wait on a round-trip and a fresh snapshot instead of
  redrawing at once.
- **The store**, once, over the full snapshot the backend already sends.

## Decision

Scope at the store. `app/store.ts` keeps the full snapshot, and:

- `groups()` returns the **active workspace's** projects, and `sections()` its
  section buckets with other workspaces' session ids dropped. These are what
  every view reads.
- `allGroups()` returns every project, for the few callers that must see past
  the active workspace: lookups by id or tmux name (`findSession`,
  `findSessionByTmux`, `groupOf`), first-run onboarding (the app has projects
  even if this workspace has none), per-workspace project counts, and terminal
  ownership.

The scoped views are computed once per (snapshot, workspace) pair, not on each
call. Filtering sections afterwards is exact: `build_sections` returns every
bucket, empty ones included, and orders within a bucket by per-session
timestamp, so dropping ids gives what filtering first would.

This mirrors the design handoff's `visibleProjects` selector and the viewmodel
crate's `projects_in_workspace`. What "in a workspace" means
(`inWorkspace`), and the active workspace itself, live in `app/workspaces.ts`.

## Consequences

- A new view is scoped for free and cannot forget to filter. The one rule to
  know: read `groups()`; reach for `allGroups()` or a `find*` lookup only when
  the caller genuinely needs every workspace, and say why at the call site.
- `groups()` no longer means "every project". Code that looks a session or
  project up by id must use the lookups, or it misses sessions in hidden
  workspaces (an attached terminal's session, say).
- Switching is instant and needs no backend call: set the active workspace,
  and the next render reads a different scope. The snapshot still carries
  every workspace, which costs nothing extra since the backend builds it all
  anyway.
- Hidden is not stopped. Terminals and PTYs for other workspaces stay
  attached; the tab strip shows only those whose session or project shell is
  in scope (`terminal/state.ts`, `scopeTerminals` in `terminal/surface.ts`),
  so switching back reconnects nothing.
- Signals from other workspaces (the TUI's "waiting elsewhere") are not shown,
  by product decision. Adding one later means reading `allGroups()` in the
  attention pill, a deliberate exception rather than a leak.
