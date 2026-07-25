---
target: detail sidebar (src/main.ts)
total_score: 24
max_score: 36
na_heuristics: 10
p0_count: 0
p1_count: 2
timestamp: 2026-07-24T18-20-19Z
slug: detail-sidebar-src-main-ts
---
# Critique — Detail Sidebar (`#detail`)

Method: dual-agent (A: aa51edf6a23143f04 · B: ad7bb3e032cf1fcac)
Mode: Operate. Surface: right-hand session-detail panel. Markup `index.html:118-137`; logic `src/main.ts:1323-1516`; CSS `src/style.css:4104-4315`.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Loading/Generating states exist and read well, but the 2s poll silently rebuilds meta/diffstat and no state dot/pill appears in the header. |
| 2 | Match System / Real World | 3 | "◀ Collapse" is mislabeled — it closes (identical to ×); label doesn't match behavior. |
| 3 | User Control and Freedom | 2 | No keyboard way to open or close; Escape does not dismiss (`main.ts:4381` only clears the row cursor). Mouse-only dismissal in a keyboard-first product. |
| 4 | Consistency and Standards | 2 | Mono-for-Data broken (Branch/PR#/Created in sans, `style.css:4160-4167`); off-scale radii (`.detail-action` 6px `style.css:4290`); no 0.12s transitions or themed `:focus-visible` in the block; two buttons doing one job. |
| 5 | Error Prevention | 3 | Open-PR disabled when no PR (`main.ts:1422`); Generate guards double-fire (`main.ts:1448`). |
| 6 | Recognition Rather Than Recall | 3 | Everything relevant is on screen, but a truncated title has no `title` tooltip to recover the full string. |
| 7 | Flexibility and Efficiency | 2 | Resizable + palette-reachable, but no toggle shortcut, and the PR URL can't be reliably selected/copied (poll wipes it every 2s). |
| 8 | Aesthetic and Minimalist | 3 | Clean and dense; minor clutter — the PR row prints the full URL inline (`word-break: break-all`) duplicating the Open-PR button. |
| 9 | Error Recovery | 3 | Summary errors show and Generate stays available for retry, but the message is raw `String(e)` (`main.ts:1455`). |
| 10 | Help and Documentation | n/a | Expert internal tool; per PRODUCT.md density beats onboarding, and the panel has no docs affordance to score. |
| **Total** | | **24 / 36** | **Acceptable (67%) — competent, real consistency + keyboard gaps** |

Applicable maximum 36 (heuristic 10 scored n/a). Most real UIs land 20–32/40; renormalized 24/36 = 67%.

## Design Specificity Verdict

**Mostly a generic inspector, lightly dressed.** It would survive a copy-paste into any dev tool with only the "Generate sends the branch diff to Claude" copy giving it away.

**LLM assessment (A):** Product-grade touches exist — the colorized `+adds / −dels` diffstat over a proportional bar (`main.ts:1391-1402`, `style.css:4243-4258`) is genuinely diff-native and shares `--success`/`--danger` with the review surface; the honest Generate empty-state copy (`main.ts:1433`) fits the "Honest by construction" principle. But the structure is stock metadata `<dl>` + diffstat + AI blurb + tags. The biggest missed-character opportunity: the panel does not lead with the one signal the north star elevates — session state/liveness. The signature row dot (State-Color Lockstep, with its non-color glyph cue) is absent; status is demoted to a plain-text `dt/dd` row (`main.ts:1371-1372`) with no color, dot, or glyph.

**Deterministic scan (B):** Detector clean — `node .claude/skills/impeccable/scripts/detect.mjs --json index.html` returned `[]`, exit 0, zero rules triggered. No hardcoded hex/rgba in the detail CSS block; all colors resolve through `var(--token)` or `color-mix()` off a token. B independently surfaced the token-hygiene issues the design review flagged: off-scale raw-pixel radii (`.detail-action` 6px `style.css:4290`; `.detail-tag` 10px `:4274`; `.diffstat-bar` 2px `:4247`), no 0.12s transitions anywhere in the block (hover states snap), and no themed `:focus-visible` — focus relies on the UA default ring.

**Visual overlays:** None. Native Tauri WKWebView app with no browser/backend driver in this session; browser visualization skipped and no user-visible overlay exists. Evidence is drawn from source.

**Where they agree / diverge:** A and B agree the detail CSS has off-scale radii and that icon buttons carry only `title` (no `aria-label`). B confirms there are no raw color violations, so A's consistency deductions rest on typography (sans-for-data), radii, and interaction, not palette. B adds two findings A did not name explicitly: the block has no transition easing and no themed focus style. No material false positives; the diffstat's green/red bar is redundant to the `+/−`-prefixed counts, so color-alone is not a true failure there.

## Overall Impression

A competent, honest inspector that gets the payoff hierarchy right (accent-tinted Review as the destination) but under-delivers on the product's two loudest commitments: keyboard-first operation and leading with session state. The single biggest opportunity is to make the panel feel like the deepest view of a *live Claude session* — lead the header with the same dot/glyph/color state vocabulary the rows use — and to make it fully keyboard-operable (toggle shortcut + Escape-to-close).

## What's Working

1. **Diffstat is product-grade.** Parsed counts with grayscale-safe `+/−` glyphs plus a proportional bar, all on semantic tokens (`main.ts:1391-1402`, `style.css:4243-4258`), with graceful "No changes" / verbatim-fallback / "Loading…" states (`main.ts:1403-1408`).
2. **Honest, reassuring Generate flow.** Names the outbound data, guards double-fire, caches per session so the 2s poll doesn't clobber a ready summary, and keeps Generate available after an error for retry (`main.ts:1425-1458`).
3. **Correct payoff emphasis.** The accent-tinted primary "± Review diff" and disabled-when-no-PR guard get the action hierarchy right (`style.css:4301-4305`, `main.ts:1422`).

## Priority Issues

**[P1] No keyboard open/close; Escape doesn't dismiss.** `main.ts:4381` (Escape only clears the row cursor); no toggle binding.
- Why it matters: Keyboard-first operability is a binding brand commitment; every other core surface (palette Cmd+K, explorer Cmd+E) has a key. The detail panel is the one core view you can't open or close without a mouse.
- Fix: Add an Escape branch that calls `closeDetail()` when `#detail` is open, and register a `toggle_details` keybinding.

**[P1] The 2s poll wipes the meta list, breaking text selection/copy of branch & PR URL.** `main.ts:1370` (`detailMetaEl.innerHTML = ""` inside the polled `renderDetail`).
- Why it matters: Copying a branch name or PR URL to paste into Slack is a coin-flip against the timer — a common expert task silently sabotaged.
- Fix: Diff-update the `dd` text in place, or skip the meta rebuild when values are unchanged, so selection survives.

**[P2] Redundant "◀ Collapse" / "× Close" both call `closeDetail`.** `main.ts:1508-1509`, `index.html:120-122`.
- Why it matters: Forces a "which one do I want?" micro-decision with no answer, on the very first glance at the panel; "Collapse" also claims a behavior it doesn't have.
- Fix: Drop one, or make ◀ genuinely collapse-to-rail and reserve × for close; at minimum relabel ◀.

**[P2] Machine data rendered in sans, violating the Mono-for-Data rule.** `#detail-meta` has no `var(--font-mono)` (`style.css:4160-4167`); Branch/PR#/Created are sans.
- Why it matters: Breaks the design system's defining discipline and weakens the "brand is the structure" claim; machine data doesn't visually separate from human labels.
- Fix: Render Branch, PR#, and Created values in `var(--font-mono)` like the diffstat counts.

**[P2] State transitions and the region are not announced to screen readers.** `#detail` has no landmark label (`index.html:118`); no `aria-live` on `#detail-diffstat` / `#detail-summary`; icon buttons carry only `title`, no `aria-label`.
- Why it matters: SR users get no notice that Generate finished or failed (contrast the board attention pill at `main.ts:3828`, which sets `aria-live="polite"`); "◀"/"×" announce as punctuation.
- Fix: Add `aria-label` to the aside, `aria-live="polite"` to the summary and diffstat containers, and `aria-label`s to the ◀/×/↻ buttons.

**[P3] Off-scale radius, no themed focus, no easing, no tooltip on truncated title.** `.detail-action` uses `6px` not `--radius-1` (`style.css:4290`); no `:focus-visible` or 0.12s transitions in the block; `#detail-title` truncates with no recoverable full text (`style.css:4128-4136`).
- Why it matters: Token-hygiene and polish gaps that make the panel feel bolted-on rather than part of the system.
- Fix: Use `var(--radius-1)`, add the 0.12s hover easing and a themed accent focus ring, and set `title` on `#detail-title` to the full string in `renderDetail`.

## Persona Red Flags

**Alex (impatient power user):**
- No shortcut to toggle the panel — must mouse to the `ⓘ` row action (`main.ts:2031`) or the context-menu "Details" (`main.ts:2186`).
- PR URL not reliably selectable/copyable — `renderDetail` runs `detailMetaEl.innerHTML = ""` every 2s (`main.ts:1370,1503`), destroying in-progress selection.
- Two-button header wastes a decision on identical actions (`main.ts:1508-1509`).

**Sam (keyboard-only / screen reader / contrast):**
- Cannot dismiss by keyboard — Escape is intercepted to only clear the row cursor (`main.ts:4381`); reachable by Tab but the natural dismiss key is dead.
- No semantics on the region — `<aside id="detail">` (`index.html:118`) has no `role`/`aria-label`; announced as an unlabeled aside.
- State transitions are silent — diffstat "Loading…", summary "Generating…"/error (`main.ts:1436,1439`) are text swaps with no `aria-live`.
- Icon-only buttons rely on `title` alone (`index.html:120,122`); no `aria-label`.
- Disabled Open PR sits at opacity 0.5 (`style.css:4311-4313`) — under 4.5:1 and gives no textual "no PR yet" cue.
- The proportional diffstat bar (`style.css:4252-4257`) is color-only; the grayscale-safe channel is the `+/−` counts above it, not the bar.
- No themed `:focus-visible` on detail controls — focus indication is the UA default ring only.

## Minor Observations

- Disabled Open-PR communicates nothing about *why* — add `title="No PR for this session"` when disabled.
- Summary error is raw `String(e)` (`main.ts:1455`) — a one-line "Couldn't generate — {e}" frame would read better.
- PR meta row duplicates the Open-PR button by also printing the full URL with `word-break: break-all` (`main.ts:1379`) — ugly wrap; consider dropping or truncating the inline URL.
- `.detail-tag` (10px, `style.css:4274`) and `.diffstat-bar` (2px, `style.css:4247`) hardcode radii rather than using tokens — hygiene nits.

## Questions to Consider

1. If "what needs you, and what's in progress" is the north star, why does the deepest single-session view render session state as plain text in row 4 instead of leading with the same dot/glyph/color vocabulary every row uses?
2. Two buttons that both close the panel: was ◀ meant to collapse to a rail (keeping a sliver visible) and never built — or is this genuinely two names for one action nobody questioned?
3. For a keyboard-first tool, the detail panel is the one core surface with no shortcut and no Escape-to-close. Is it a first-class view, or a mouse-driven afterthought bolted onto the fleet view?
