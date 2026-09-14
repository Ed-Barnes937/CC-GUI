# Idea: offer Oh My Pi in the harness picker

> **Status: not implemented.** Captured idea, not shipped behaviour. Delete
> this file when the work lands. Library support since claude-commander
> **v0.34.0** (upstream #293).

## What this is

CC's harness abstraction (`claude_commander_core::agent`) recognises **Oh My
Pi** (`omp`) alongside Claude / Codex / OpenCode: state detection (working /
waiting) works for `omp` panes since v0.34.0. CC-GUI's harness picker
(`src/harnessPicker.ts`) shows configured programs plus a built-in fallback
set (`BUILTIN_PROGRAMS`) of Claude / Codex / OpenCode - Oh My Pi is missing
from the fallback, so a user without a configured programs list can't pick it.

## The change

- Add `{ label: "Oh My Pi", command: "omp" }` to `BUILTIN_PROGRAMS` in
  `src/harnessPicker.ts` (order after OpenCode).
- Check the picker's "unconfigured" heuristic and the harness iwft scenario
  (`src/playwright/iwft/scenarios/harnessPicker/`) still hold with four
  entries.

Nothing backend-side: state detection comes from the library via the session's
`program` string, same as OpenCode. Related: [programs-list](programs-list.md).
