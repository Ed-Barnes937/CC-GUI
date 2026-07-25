---
target: Board view (kanban columns + attach dock)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-07-24T18-20-17Z
slug: src-main-ts-board-view
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Rich per-card status (chips, diffstat, counts, dock header); but the docked/selected card is barely marked — a faint `surface2` hairline (`style.css:606-609`). |
| 2 | Match System / Real World | 3 | Domain language is right (sections, `⎇` branch, Review, Attach); dock placeholder says "Press ▸" but the button reads "Attach" (`index.html:151`). |
| 3 | User Control and Freedom | 3 | Hide-empty, project filter, search, drag-repin, dock close/expand — but no undo on a drag re-pin and no keyboard move/escape path. |
| 4 | Consistency and Standards | 2 | Selection abandons the system's accent-left-border language; `.board-attention` comment contradicts itself; hardcoded `rgba()` in the dock. |
| 5 | Error Prevention | 3 | Destructive actions sit behind the `⋯` menu, not one-click; drag-repin is low-stakes/reversible. |
| 6 | Recognition Rather Than Recall | 3 | Labeled chips + labeled actions (not icon-only), project named per card; `▸`/Attach copy mismatch nicks it. |
| 7 | Flexibility and Efficiency | 2 | Primary actions ARE Tab-reachable (Attach/Review/⋯ are real buttons; attention pill fully keyboard-wired) — but no roving card/column arrow-nav, no Enter-to-attach on the card body, repin/reorder are drag-only. |
| 8 | Aesthetic and Minimalist Design | 2 | ~6 regions + two always-visible tinted action buttons per card (~160px tall); heavy chrome contradicts "the shell recedes" at fleet scale. |
| 9 | Error Recovery | 3 | `pull-blocked` = single reserved `⚠`/danger chip (`status.ts:150`) reads the problem state clearly; no other board-specific error surface. |
| 10 | Help and Documentation | 2 | Board has no entry in the `?` overlay (`help.ts`); only the dock placeholder hint. Low need for experts, but zero coverage. |
| **Total** | | **26/40** | **Acceptable** |

Applicable max: 40 (all ten scored). Band: Acceptable (20–27) — significant improvements needed before the surface fully serves its purpose.

## Design Specificity Verdict

**Authored for this product in its signature moves; generic in its organizing axis.**

A generic kanban app could not ship this unchanged. Product-specific moves:
- The **dock** re-parents the *live PTY terminal* of the attached session inline (`index.html:150`, `#board-dock-surface` at `style.css:870`) — you preview real session output without leaving the board. No kanban tool does this. Fullscreen expand (`style.css:804-813`) is a thoughtful "dismissable, not swallowed" detail.
- **State-color left spine in lockstep** (`.agent-card` border-left `style.css:590` + `.state-*` at `307-327`), grayscale-safe status chips pairing color + word + glyph (`status.ts:76-84`), diffstat bars, PR/comment/`pull-blocked` chips.
- Fully token-driven / `color-mix`-based, so it reskins across all 19 themes.

**But the information architecture is generic where it matters most.** The board's organizing axis is **section** (one column per section), and within a column cards bucket in **project/group order** (`board.iwft.ts:233-236`) — never by status. The product's north star is *"what needs you, what's in progress."* On this board that signal is a single passive count at the top (`.board-attention`); it does not structure columns and does not sort cards. The sidebar's Status grouping (`STATUS_TIERS` Needs you / Active / Parked, `status.ts:93-96`) serves the north star directly — the board does not. That is the headline design gap.

**Deterministic scan**: detector ran clean — `index.html` and `src/main.ts` both exit 0, zero findings. This is largely uninformative: the board's markup is built at runtime via `document.createElement` in `renderBoard`/`renderAgentCard`/`renderBoardColumn` (`main.ts` ~3531-4004), so a static markup scanner sees construction calls, not the resulting DOM. The substantive evidence is the manual code/CSS read below. (Note: an early claim that the board rendering was "missing from main" was a broken-grep artifact in one assessment — the board is fully present and wired.)

## Overall Impression

The board has a genuinely product-specific centrepiece — the live-terminal dock — and disciplined, grayscale-safe status vocabulary. But it is organized as a project manager's kanban (columns = sections) rather than the fleet-triage surface the product describes, so at 40 sessions the one signal that matters ("what needs me now") is buried mid-column instead of sorted to the top. The single biggest opportunity: make Status the board's primary axis (or at least sort attention-state cards up), and lighten the cards so the dock becomes the star.

## What's Working

1. **Live-terminal dock** (`index.html:150`, `style.css:870-884`) — re-parenting the actual PTY into a bottom dock is the board's signature, product-only move and its emotional peak: click a card, watch the real session terminal appear.
2. **Grayscale-safe status vocabulary** (`status.ts:76-84`, `.status-chip.compact` `style.css:1416-1428`) — `Done` and `Waiting` share `--warning` but differ by glyph + word (`dot` vs `?`), so state survives color-blindness and grayscale. Exactly the State-Color Lockstep discipline the design system promises. The attention pill is also the one exemplary control: `role="button"`, `tabIndex=0`, `aria-live="polite"`, keyboard-wired (`main.ts:3824-3830`).
3. **Careful density/overflow handling** — diff counts wrap instead of clipping (`style.css:709-717`), columns scroll rather than clip (`#board-columns` `overflow-x:auto` `510`; `.board-col-body` `overflow-y:auto` `579`), and ellipsis on every truncatable field. Long names are handled cleanly.

## Priority Issues

### [P1] Information architecture doesn't serve "what needs you"
- **Why it matters**: The product's north star is triage. Columns are sections and cards sort by project/group order (`board.iwft.ts:233-236`), never by status; attention is a passive top-bar count only (`.board-attention`, `style.css:347`). On a 40-session board a "Waiting on you" card sits buried below running cards in a tall column — the board answers "how is work organized," not "what needs me now."
- **Fix**: Offer a Status/tier grouping mode for columns (reuse `STATUS_TIERS`, `status.ts:93-96`), or at minimum sort attention-state cards to the top of each column and lift them visually (the sidebar already amplifies `tier-attention`, `style.css:964`).
- **Suggested command**: `$impeccable shape`

### [P1] No roving keyboard navigation across the board
- **Why it matters**: Full keyboard operability is a binding product constraint (`PRODUCT.md`). Primary actions *are* reachable — Attach (`main.ts:3657`), Review (`3665`), ⋯ (`3591`) are real Tab-reachable buttons and the attention pill is fully wired — so the task is completable, but only by tabbing linearly through ~80 buttons at 40 sessions. The card body is a non-focusable `<div>` with click + contextmenu but no `role`/`tabindex`/`keydown` (`main.ts:3535, 3679-3680`); there is no arrow-key nav across cards/columns, no Enter-to-attach on the card, and repin/reorder are drag-only (`main.ts:3543, 3766`). `#board-columns` has no `role`/`tabindex`/`aria-label` (`index.html:140`) unlike the sidebar's `#sessions role="listbox" tabindex="0"`.
- **Fix**: Give `#board-columns` a roving-tabindex model (arrow keys across columns/cards), make cards `role="button"` + focusable with the 2px accent focus outline the system already defines, bind Enter=attach, add a keyboard move command for repin, and mirror the sidebar's listbox semantics.
- **Suggested command**: `$impeccable harden`

### [P2] Card density defeats the fleet-glance purpose
- **Why it matters**: Each card stacks header (title+project+menu), status row, branch subtitle, diffstat bar+counts, chip row, and two always-visible labeled action buttons (`style.css:611-766`) — ~160px tall. DESIGN.md's own rule is "don't add chrome that competes with session content; the shell recedes." At 40 cards that is ~80 tinted buttons on screen; fewer cards are visible and scanning slows. No focal point: column-name and card-title are both 14px/600 and the two accent-tinted buttons pull the eye as hard as the title.
- **Fix**: Reduce the resting card to a scannable tile (title + status chip + project + diffstat); reveal Attach/Review on hover/focus/selection; keep one primary (Attach) and demote Review to the `⋯` menu. This also frees the room the keyboard focus states need.
- **Suggested command**: `$impeccable distill`

### [P2] Selected/docked card and board focus states are nearly invisible
- **Why it matters**: The system reserves a 2px accent left border for a selected row (DESIGN.md Shapes); the board spends the left border on state and marks the selected/docked card with only a faint `surface2` hairline (`style.css:606-609`) — you can't tell which card is docked, and it's a color-only cue with no text/glyph (fails Sam). Separately, only three `:focus-visible` rules exist in the whole stylesheet (`style.css:228, 367, 4042`); none cover `.board-pill`, `.card-action`, `.board-search`, `.board-project-row`, `.card-menu`, `.board-new`, or the dock buttons, so board controls fall back to the WKWebView default outline — inconsistent, and a visibility risk on buttons sitting on tinted fills.
- **Fix**: Restore an unmistakable docked-card treatment (accent outline plus a text/glyph "▸ docked" marker, not color alone); apply the system accent focus ring to every board control.
- **Suggested command**: `$impeccable polish`

### [P3] Token / consistency drift on the dock and card copy
- **Why it matters**: Breaks theming and clarity. Hardcoded `rgba(0,0,0,0.5)` scrim on `#board-dock-backdrop` (`style.css:819`) instead of `--scrim` — in the Latte/light theme the fullscreen-dock backdrop becomes a heavy pure-black overlay; raw shadow on `.dock-fullscreen` (`style.css:811`) instead of `--shadow-dialog`. `.board-attention` self-contradicts: its comment says "A summary, not a control" (`style.css:348`) then "Mirror of the accelerator: click / Enter jumps" (`361`). The card title's hover tooltip shows `Branch: …` (`main.ts:3579`), so a truncated long session *name* has no way to reveal its full text.
- **Fix**: Swap raw `rgba()` for `--scrim` / `--shadow-dialog`; pick one behavior for the attention pill and align the comment; set the title's `title` attr to the full session name.
- **Suggested command**: `$impeccable polish`

## Persona Red Flags

**Alex (impatient power user)**: Can attach, but slowly — must Tab through ~80 buttons or mouse to each card's `.card-action.attach` (`style.css:768`); no toggle shortcut to reach Board, no arrow-nav, no Enter-to-attach on a card. The one accelerator (`.board-attention`) is ambiguous (is it a control?). For this exact audience the board is slower than the sidebar it's meant to scale beyond.

**Sam (accessibility / keyboard / color)**: Wins on labeled status chips (word+glyph+color, `status.ts:76-84`) and the fully-wired attention pill. Fails on: cards are non-focusable `<div>`s and `#board-columns` has no `role`/`tabindex`/`aria-label` (`index.html:140`); the docked card is marked color-only by a faint `surface2` hairline (`style.css:606`) with no text/glyph cue; `.board-search` is labeled only by placeholder (`main.ts:3850`); 11px `text-dim` project/branch text (`style.css:641-642, 679`) risks contrast failure on `bg-elevated`.

**Riley (stress tester)**: 0 sessions → board mode hides the onboarding pane (`style.css:288-292`) and shows empty section columns + "No session attached" with no guidance. 40+ → tall scrolling columns + horizontal column scroll + buried attention + ~80 action buttons. Long names → handled well (ellipsis everywhere), except the title tooltip shows branch not name (`main.ts:3579`).

## Minor Observations

- Dock placeholder "Press ▸ on a card to attach" (`index.html:151`) references a glyph the actual button doesn't use (it reads "Attach").
- `#board-dock` is a fixed 194px (`style.css:788`), not user-resizable — odd for a live-terminal preview you'd want to enlarge without going fullscreen.
- The hashed per-project color (`--proj-color`, a system signature used for sidebar spines) is unused on cards; project identity is dim text only. A project dot would scan faster at fleet scale.
- "No section" catch-all shows a `0` column by default (Hide-empty is opt-in, `board.iwft.ts:199-206`) — mild default clutter.

## Questions to Consider

1. If the north star is "what needs you," why is the board's primary axis **section**, and why is attention only counted, never sorted or column-ized? Should Status be the default grouping and Section the option — the inverse of today?
2. The sidebar already scales to many sessions with status tiers. What does the board *earn* that the sidebar + dock don't — is its distinct value the live-terminal dock, and if so should the columns be far lighter (tiles) so the dock is the star?
3. Two always-visible actions per card × 40 cards — is that honoring "the shell recedes," or has the board become the loudest surface in a product that prizes quiet?
4. Should the docked terminal be resizable / multi-pane like Console's 4-way split, or is a single 194px dock the deliberate ceiling?
