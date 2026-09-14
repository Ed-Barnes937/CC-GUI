# Idea: set session base (retarget a stack parent)

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library surface available since
> claude-commander **v0.36.0** (upstream #307).

## What this is

CC can retarget a session's stack base after creation: stack it onto another
session in the same project, or unstack it onto the project's main branch.
The TUI exposes this from its palette ("Set session base"); CC-GUI has no way
to fix a mis-stacked session - today the parent is fixed at create time.

## The library surface

`claude_commander_core::api::CommanderService`:

- `set_session_base(&SessionId, parent: Option<SessionId>) -> Result<SetSessionBaseOutcome>`
  - `parent: Some(id)` stacks onto that session; `None` unstacks onto main.
  - Metadata and PR base only - git history is deliberately untouched, so the
    branch still carries its old base's commits until the user rebases.
  - Validates inside one `try_mutate` (cycle checks against live state); a
    refused plan writes nothing.
- `SetSessionBaseOutcome { new_base_branch, old_base_branch, pr: PrRetarget }`
  where `PrRetarget` is `NoPr` / `Retargeted { pr_number }` /
  `Failed { pr_number, message }` - the `Failed` arm means local metadata moved
  but `gh pr edit --base` didn't, worth a toast.

## GUI integration

- `src-tauri/src/cascade.rs` (or `sessions.rs`) - thin `set_session_base`
  command delegating to the service; return the outcome for toasts.
- `src/session/row.ts` - "Set base…" entry in the shared session context menu,
  opening a picker of same-project sessions plus "main (unstack)".
- `src/palette.ts` / `src/commands.ts` - palette action for the selected
  session.
- Surface the `PrRetarget::Failed` message via `src/toast.ts` so a half-moved
  base isn't silent.

## Verification (when implemented)

- iwft scenario: seed a stacked pair, retarget the child, assert the sidebar
  stack topology and the PR-base field update (extend `TauriSimulator`).
- Warn/copy in the UI that git history is untouched (mirrors the library doc).
