# ADR-0002: Live reload via polling, not a filesystem watcher

Date: 2026-08-01
Status: accepted

## Context

The markdown viewer's core scenario is reading a plan *while an agent is
still editing it*. The prototype read the file once per open, so the doc went
stale immediately. Candidate mechanisms: frontend polling of
`read_session_file`, a `notify`-based filesystem watcher pushing Tauri
events, or refresh-on-focus (rejected outright — the user is already focused
on the viewer while the agent writes, so no refocus event ever fires).

## Decision

**Poll while the viewer is open**: the frontend re-invokes
`read_session_file` for the displayed file on a ~1–2s interval, compares
content, and re-renders only on change.

Rationale:

- Background polling loops are already this codebase's standard pattern
  (`polling.rs` drives the sidebar); a watcher would introduce a second
  architecture (crate + per-open/per-session watcher lifecycle + platform
  edge cases) for sub-second latency a human reader can't perceive.
- Cost exists only while the viewer is open; failure mode is a late refresh,
  not a leaked watcher.

## Consequences

- Updates appear within the poll interval (~1–2s) — acceptable for reading.
- Re-render must preserve scroll position and avoid flashing while the agent
  appends — a frontend requirement independent of the mechanism.
- If a future feature needs instant or repo-wide change events, revisit with
  `notify`; nothing in this design blocks that.
