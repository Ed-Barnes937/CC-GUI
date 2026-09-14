# Idea: user-facing Reset session (restart without resume)

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.35.0** (upstream #296).

## What this is

CC's TUI has a Reset command: relaunch a session's agent **fresh**, without
`--resume` - for when a conversation is wedged, or the user wants a clean
context on the same branch/worktree. CC-GUI only uses the fresh-restart path
internally for crash-loop recovery (`restart_fresh` by tmux name, driven by
`src/terminal/restart.ts`); there is no user-facing action.

## The library surface

`claude_commander_core::api::CommanderService`:

- `restart_session_fresh(&SessionId) -> Result<()>` - the id-addressed twin of
  `restart_session` (which resumes). Same worktree, same branch, no resume.

## GUI integration

- `src-tauri/src/sessions.rs` - thin `reset_session(id)` command next to the
  existing `restart_session`.
- `src/session/row.ts` - "Reset (fresh restart)" in the shared context menu,
  visually separated from Restart so the destructive nuance (conversation not
  resumed) is clear; confirm like Kill does.
- `src/palette.ts` / `src/commands.ts` - palette entry; update `src/help.ts`
  and the README keyboard table if it gets a binding.

## Verification (when implemented)

- iwft scenario: reset a running session, assert the simulator saw a fresh
  launch (no resume flag) and the terminal reattaches.
