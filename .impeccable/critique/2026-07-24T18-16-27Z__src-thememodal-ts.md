---
target: Theme picker modal
total_score: 24
max_score: 36
na_heuristics: 9
p0_count: 0
p1_count: 2
timestamp: 2026-07-24T18-16-27Z
slug: src-thememodal-ts
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live preview + ✓ + toggle are immediate, but no "previewing / unsaved" label or apply/cancel hint. |
| 2 | Match System / Real World | 3 | "Follow system", swatches, real theme names read naturally; native popover feel. |
| 3 | User Control and Freedom | 3 | Esc / outside-click revert with correct non-destructive semantics; no visible affordance says so. |
| 4 | Consistency and Standards | 2 | Custom `<span>` toggle instead of a standard switch; radii 6px/8px off the documented 7/10/12 scale; no type-ahead while the app palette is fuzzy. |
| 5 | Error Prevention | 3 | Nearly impossible to err — preview is transient, commit is reopen-reversible. |
| 6 | Recognition Rather Than Recall | 3 | Swatches + labels aid recognition; but Esc-reverts must be recalled (nothing on screen says so). |
| 7 | Flexibility and Efficiency | 2 | Arrows + hover + Enter + seeded selection, but no type-ahead, no Home/End/PageUp — a 19-keypress arrow slog on a keyboard-first product. |
| 8 | Aesthetic and Minimalist Design | 3 | Quiet, restrained, correct; minor low-information 3-swatch triple. |
| 9 | Error Recovery | n/a | This surface has no error states; theme-file validation lives in `theme.ts:validateTheme`, not the picker. |
| 10 | Help and Documentation | 2 | No inline key hint; a one-line footer ("↑↓ preview · ↵ apply · esc cancel") is cheap and would help. |
| **Total** | | **24/36** | **Acceptable (67%)** |

Scored max = 36 (heuristic 9 = n/a). 24/36 = 67%.

## Design Specificity Verdict

**Strongly product-specific, with two unfinished seams.** This is authored for CC-GUI, not category-interchangeable:

- It is a **popover, not a modal** — anchored top-right under the `◐` titlebar button, transparent catch layer with **no dark scrim** (`themeModal.ts:48-49`, `style.css:2696-2720`). A deliberate native-desktop decision.
- Every row **reskins through the 21-token contract** — background, border, selection, toggle, check all `var(--…)` with zero hardcoded hex (`style.css:2702-2812`). The picker eats its own dog food: previewing a theme restyles the picker itself. **Assessment B confirms zero hardcoded colors** in the CSS block; the one dynamic color (`themeModal.ts:81`, swatch dots from `t.cssVars`) is legitimate theme data.
- Transitions are **0.12-0.13s** (`style.css:2711, 2790, 2802`), matching the "fast" spec exactly.
- The **✓ stays pinned to the resolved active theme even while browsing** (`themeModal.ts:34, 88`) — a "home anchor" so live-preview never loses your real theme. Thoughtful and product-specific.
- **Correct appearance-aware cancel/commit** (`themeModal.ts:126-134`): preview is a pure transient apply, cancel re-resolves from saved prefs, commit records per-appearance so system mode reuses the slot.

Where it falls short: `theme.ts:21` advertises `source` "for picker grouping" and `THEMES` is ordered dark-then-light — but the picker renders one **flat, ungrouped 20-item list** and never groups. And the app's own `Cmd+K` palette is fuzzy-searchable, yet this list has **no type-ahead** — an internal inconsistency.

**Deterministic scan:** The mechanical detector (`detect.mjs --json src/themeModal.ts` and `index.html`) returned **exit 0 / zero findings on both**. This is a **null result, not a clean bill** — the detector scans static markup, and this component builds all DOM at runtime in JS, so there was nothing for it to see. All real evidence is from code/CSS reading. No false positives to flag.

**Browser overlays:** none. CC-GUI is a native WKWebView app with no browser/screenshot driver, so live injection, screenshots, and contrast ratios could not be measured. Contrast is reported as token pairs only.

## Overall Impression

The engineering underneath this picker is genuinely good — the hardest part (revert correctness across OS-appearance flips, per-appearance commit, total token discipline) is right, and live full-app preview is a real delight for an expert who theme-shops. What drags it down is **legibility and reach**, not correctness: the one indicator that matters during preview (the selected row) can vanish on some themes, the surface is invisible to assistive tech, and a keyboard-first product ships a 20-item list with no type-ahead. The single biggest opportunity: make the selection cue theme-independent and give the list the same fuzzy-jump muscle the rest of the app has.

## What's Working

1. **The pinned-✓ home anchor** (`themeModal.ts:34, 88`). Keeping the check on the *resolved active* theme — even while previewing others, even in system mode — gives a constant "this is really yours" reference during destructive-looking preview. Specific, correct, rare.
2. **Correct, appearance-aware cancel/commit semantics** (`themeModal.ts:126-134`). Preview is a transient apply with no cache write; cancel re-resolves from saved prefs; commit records per-appearance. The hard part is right.
3. **Total token discipline** (`style.css:2702-2812`, corroborated by the detector's zero color findings). Every color is a semantic var; the picker reskins with the theme it previews, including the toggle knob (`--bg-base` on `.on::after`).

## Priority Issues

### [P1] Screen-reader / assistive-tech operability is absent
- **Why it matters:** The product mandates "full keyboard operability." Sighted arrow-nav works, but Assessment B confirms the overlay, list, and rows are all bare `<div>`s (`themeModal.ts:50-104`): no `role="listbox"`/`option`, no `aria-selected`/`aria-checked`, no accessible popover name, and the follow-system toggle is a `<span>` with no `role="switch"`. Only the container is focusable (`box.tabIndex=-1`); rows have no `tabIndex`. A screen-reader user gets unlabelled div soup — no option count, no selection announcement, no toggle state, no "current" on the ✓.
- **Fix:** `role="listbox"` + `aria-activedescendant` on the box (it already holds focus), `role="option"` + `aria-selected` per row, `role="switch"` + `aria-checked` on the toggle, `aria-label="Theme"` on the popover, `aria-label="current"` on the ✓. Cite `themeModal.ts:56-104`.
- **Suggested command:** `$impeccable harden`

### [P1] Selection highlight is near-invisible on several themes
- **Why it matters:** The selected row — which is also the **live-preview target** — is indicated *only* by `background: var(--bg-inset)` against the panel's `var(--bg-elevated)` (`style.css:2739-2741, 2707`). Assessment B confirms this is the component's single visual state (hover, keyboard position, and selection all collapse into one background fill; `.theme-modal` is `outline:none`). On themes where those two tokens are nearly identical it disappears during the exact operation where the user needs it: **Nord** elevated `#2b3039` vs inset `#272b33`; **Everforest Dark** `#272e33` vs `#232a2e`; **Everforest Light** `#f4f0d9` vs `#efebd4` (`theme.ts:412-437, 632-654, 902-924`).
- **Fix:** Add a theme-independent cue — a 2px `border-left: var(--accent)` inset bar or `outline: 1px solid var(--accent)` on `.theme-modal-row.selected` — so it never depends on the bg-inset/bg-elevated delta. Cite `style.css:2739`.
- **Suggested command:** `$impeccable colorize`

### [P2] No type-ahead / jump keys on a 20-item keyboard-first list
- **Why it matters:** Keyboard handling is Arrow/Enter/Escape only (`themeModal.ts:135-141`) — no type-ahead, no Home/End, no PageUp/Down. Reaching the light themes at the bottom is up to 19 ArrowDown presses. This is the flagship keyboard-efficiency surface for expert users, and the same app offers a fuzzy `Cmd+K` palette, so users expect to type "dra"→Dracula here and can't. The single biggest efficiency miss.
- **Fix:** Add type-ahead (accumulate keystrokes, jump to first label match) and Home/End. Small code, large payoff. Cite `themeModal.ts:135`.
- **Suggested command:** `$impeccable harden`

### [P2] Live preview mutates the whole app with no "preview / how to exit" affordance
- **Why it matters:** Browsing calls `previewTheme` on every keystroke (`themeModal.ts:118`), re-skinning the *entire application*; a user arrowing 20 themes watches the app strobe through 12 dark and 7 light palettes. Nothing on screen states this is a reversible preview or that Esc reverts — the ✓ home-anchor is the only (silent) reassurance. Assessment B confirms the reduced-motion block (`style.css:4340-4356`) disables the popover's own fade and the toggle transition but does **nothing** about full-app color inversion on every keystroke — a photosensitivity/vestibular concern the reduced-motion path misses entirely.
- **Fix:** Add a single muted footer row (`↑↓ preview · ↵ apply · esc cancel`, `--text-dim`) — doubles as the Help/Documentation fix. Consider debouncing or gating rapid preview repaints under `prefers-reduced-motion`. Cite `themeModal.ts:106` (append after `list`).
- **Suggested command:** `$impeccable clarify`

### [P2] No focus trap — Tab escapes the open popover
- **Why it matters:** Assessment B confirms focus is set once to `box` (`themeModal.ts:150`) and Tab is not handled in `onKey` (`:135-141`), so Tab falls through to default browser behavior and moves focus to chrome behind the still-open popover. A keyboard user who reflexively Tabs strands focus outside a popover that still owns Esc/preview. `stopPropagation` is called but not `preventDefault` for Tab (`:136`).
- **Fix:** Trap Tab/Shift-Tab within the popover while open (or cycle rows), or close-on-blur. Cite `themeModal.ts:135`.
- **Suggested command:** `$impeccable harden`

## Persona Red Flags

**Alex (power user, keyboard-first) — breaks hard.**
- No type-ahead: cannot type "nord" to jump; must ArrowDown-count (`themeModal.ts:138`).
- No Home/End/PageUp: bottom-of-list themes are ~19 keypresses away.
- Tab is `stopPropagation`'d but not `preventDefault`'d (`:136`) — no focus trap; Tab strands focus on chrome behind the still-open popover.

**Sam (accessibility) — breaks hard.**
- Div-soup semantics: no listbox/option/switch roles, no `aria-selected`/`aria-checked`, no accessible popover name (B-confirmed).
- Selection contrast fails on Nord/Everforest — a low-vision sighted-keyboard user loses the cursor.
- Photosensitivity/vestibular: rapidly arrowing flips the *entire viewport* dark↔light many times/second (`:118`); the reduced-motion block does nothing about it (B-confirmed).

**Jordan (color-vision deficiency) — the swatch preview partly fails.**
- The 3-swatch read is `bg-base, accent, info` (`themeModal.ts:20`). In many themes accent and info sit in the same blue-purple band — Mocha accent `#8fb8ff` / info `#cba6f7`; Tokyo Night `#7aa2f7` / `#bb9af7` (`theme.ts` refs). For a deuteranope/protanope two of three dots collapse, so the triple carries ~one bit, not three. `bg-base / text / accent` would show background + foreground + accent (an actual contrast preview) and separate the hues.

## Minor Observations

- **Radii drift (B-confirmed):** rows use `border-radius: 6px` (`style.css:2734`), follow-row `6px` (`:2780`), tag `8px` (`:2764`) — none on the documented 7/10/12 scale; panel `10px` matches `--radius-2` numerically but is hardcoded rather than `var(--radius-2)`.
- **No label truncation:** `.theme-modal-label` is `flex:1` with no `text-overflow: ellipsis` (`:2756-2759`); a long custom label in 280px could crowd the tag/check.
- **Toggle target size (B):** the pill is `26×15px` (`:2784`), knob `11px` — below WCAG 2.2 (24px) / HIG (44px), though the whole `followRow` is the real hit target. Rows compute to ~25-27px tall, at the 24px minimum.
- **Low-info third swatch** — consider `bg-base/text/accent`.
- **`select(selected)` on open** (`themeModal.ts:149`) previews the seed even when it is already active — a harmless redundant full repaint every open.
- **Custom-theme grouping via tag only** (`:94-98`) — with many custom themes they become an unlabelled interleaved tail.

## Questions to Consider

1. If the app already has a fuzzy `Cmd+K` palette, **why is choosing a theme a 20-item arrow list at all** rather than a filtered palette mode?
2. The whole app strobes through 19 palettes as you arrow. **Is full-app live preview the right model, or should preview be scoped** (a mini chrome+terminal preview card inside the popover)?
3. The ✓ home-anchor is clever — **if it's worth engineering, why isn't it worth labelling** ("current") for sighted and SR users?
4. `source` was added "for picker grouping" and never used to group. **Dead intent, or unfinished feature** — along with search/favorites/recently-used?
5. For a keyboard-first expert, **is 20 themes a feature or a liability?** Would a curated 6-8 + "more…" serve the persona better?
