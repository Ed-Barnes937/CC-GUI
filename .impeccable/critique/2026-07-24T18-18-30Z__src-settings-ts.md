---
target: Settings pane (src/settings.ts)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-07-24T18-18-30Z
slug: src-settings-ts
---
Method: dual-agent (A: design review · B: detector + code/DOM evidence). No browser automation available (native WKWebView); Assessment B ran the CLI detector + static code/CSS reads. Not degraded.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | No load state while `get_config` awaits; a normal (non-restart) save closes silently with no toast; no save-in-progress state (settings.ts:880–883, 892). |
| 2 | Match System / Real World | 4 | Domain language is fluent — worktrees, branch prefix, WIP limit, leader key, tmux. |
| 3 | User Control and Freedom | 2 | Esc/backdrop/Cancel all exit, but discard is silent and unrecoverable — no dirty guard (settings.ts:905–914). |
| 4 | Consistency and Standards | 3 | Internally consistent, but field radii drift off the token scale and the section editor loses the mono face. |
| 5 | Error Prevention | 1 | No validation: out-of-range numbers stored as-is; blanked required numbers silently keep old value; discard has no confirm (settings.ts:307–312). |
| 6 | Recognition Rather Than Recall | 3 | Nav icons + inline field descriptions are strong; search has no per-field highlight, so a category match still forces a manual scan. |
| 7 | Flexibility and Efficiency | 1 | Keyboard-first tool with no autofocus, no arrow/type-ahead nav of 13 categories, no Cmd+S/Enter save — fails its own binding constraint. |
| 8 | Aesthetic and Minimalist Design | 4 | Quiet, dense, restrained native chrome — exactly on-brief. |
| 9 | Error Recovery | 2 | Save failure shows a toast; no field-level recovery because no field-level validation exists. |
| 10 | Help and Documentation | 4 | Category `note`s and field `desc`s are genuinely good inline docs. |
| **Total** | | **25/40** | **Acceptable — significant improvements needed** |

All 10 heuristics applied (Operate mode); none scored n/a. Applicable maximum = 40.

## Design Specificity Verdict

**The paint is authored for this product; the wiring is off-the-shelf.**

**LLM assessment (A):** The visual + data layer is genuinely "The Working Shell" — machine data renders in `var(--font-mono)` while chrome stays in the UI face (style.css:2246), color is fully tokenized, and the schema-driven fields with master-toggle gating and the custom Sections rule-editor are shaped for claude-commander, not a generic key/value dump. But the *interaction model* is category-interchangeable: it behaves like a modal any web app drops in — no keyboard story beyond browser-default Tab (violating the pane's own binding keyboard-first constraint), no save feedback, no discard safety, no validation. Those behaviors are exactly what separate a tool built for expert operators who live in it from a settings dialog shipped to complete a checklist.

**Deterministic scan (detector):** `.ts` and `index.html` returned exit 0 / empty — the detector parses markup/CSS, and the settings DOM is 100% JS-built, so nothing static to scan there. `src/style.css` returned exit 2 with 85 whole-file findings; **7 fall inside the settings block (2053–2492), all `design-system-radius`**: lines 2241 (`4px` field controls), 2320 (`20px` slider), 2350 (`5px` segment), 2389 (`8px` section card), 2405 (`4px` section-name), 2420 (`4px` section-icon), 2451 (`4px` section-grid inputs). The scale is `--radius-1/2/3` = 7/10/12 (style.css:138–140); the box, search, and nav-items use the tokens correctly, but every field control, card, section input, icon button, and segment uses raw off-scale radii. Detector **confirmed the settings CSS is color-clean** (no hex/rgba — a strength, not a violation). False positives for this target: 5 `side-tab` and 2 `design-system-color` findings are all outside the settings block.

**Visual overlays:** None. No browser/screenshot/live-server automation exists in this session (Tauri WKWebView, no headless driver). Exact contrast ratios and live reflow could not be measured — flagged as risk, not confirmed.

## Overall Impression

This is a well-built config surface with director-grade visual and content craft (type discipline, tokenized color, inline docs, schema fidelity) sitting on top of a generic, feedback-poor interaction loop. The single biggest opportunity: close the feedback and keyboard gaps. The three heuristics that matter most for an Operate tool — system status (1), error prevention (5), flexibility/efficiency (7) — are also its three lowest. Fixing those three would move this from "acceptable" to "good" without touching the look.

## What's Working

1. **Type + color discipline is real.** Inputs render in `var(--font-mono)` (style.css:2246), chrome in the UI face; every settings color routes through tokens and `color-mix` (focus ring at 2257). The detector independently confirmed zero hardcoded colors in the block. The north star, executed.
2. **Master-toggle gating with live re-render + visible dim.** Toggling a master switch re-renders so gated fields enable/disable (settings.ts:285–292, 385–388) and disabled rows dim via `.settings-field.disabled { opacity: 0.45 }` (style.css:2211). You can see what a switch controls.
3. **Theme-reskinnable select chevron.** Two CSS gradients draw the dropdown arrow so it follows `var(--text-muted)` instead of a static SVG that can't read tokens (style.css:2260–2280) — genuine craft, documented in the comment.
4. **Config-shape fidelity.** `packList`/`asList` collapse single-vs-array values to match CC's on-disk schema (settings.ts:646–707); save deep-clones then overwrites only edited leaves so unknown keys survive (877–879).

## Priority Issues

### [P1] Keyboard operability fails the pane's binding constraint
- **Why it matters:** The product brief calls keyboard reach "binding," yet a keyboard user can't see where they are or drive the pane efficiently. Both assessments hit this independently.
- **Evidence:** No autofocus on open (settings.ts:889–903 never focuses search). No arrow/type-ahead nav of the 13-category list — plain buttons (renderNav:478–493). No keyboard save — the only global key is Esc (912). And **no visible focus ring** on nav items (style.css:2140–2153, hover-only), segment buttons (2354–2371), section icon buttons (2417–2432), section-name/grid inputs (`outline:none` at 2409/2455), or footer `.row-action` (1508–1538); the toggle input is `opacity:0` (2310) with no `:focus + .slider` rule. No global `:focus-visible` fallback exists.
- **Fix:** Add a shared `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` for `.settings-nav-item, .section-icon, .settings-segment button, .settings-box .row-action, .section-name, .section-grid input` plus `.switch input:focus-visible + .slider`. Autofocus search in `openSettings`. Add Cmd/Ctrl+Enter → Save. Add arrow-key traversal of the nav list.

### [P1] Focus destroyed on every gated re-render; toggles/labels have no accessible name
- **Why it matters:** A keyboard user who flips a master toggle is thrown to `<body>`; a screen-reader user hears an unlabeled checkbox.
- **Evidence:** Flipping a master toggle calls `renderPanel()` (settings.ts:291) which does `panel.innerHTML = ""` and rebuilds (500) — focus drops. Same on section add/move/delete (721, 748, 781). `.settings-field-label` is a `<label>` with no `for`, and the control is a sibling (`row.append(head, control)`, 544) — not associated. Icon-only buttons `↑ ↓ ✕` (iconBtn 784–791) and nav icons carry no `aria-label`. The overlay is a plain `<div>` with no `role="dialog"`/`aria-modal`/`aria-labelledby` (240–246).
- **Fix:** After a gated re-render, restore focus to the triggering control (track its `data-key`). Associate labels via `for`/`id`; add `aria-label` to icon buttons; give the overlay dialog semantics.

### [P2] Silent discard of unsaved changes
- **Why it matters:** Editing 11 TTS fields then fat-fingering Esc loses everything with zero warning — destructive and unrecoverable.
- **Evidence:** Esc, backdrop, and Cancel all call `closeSettings()`, which only hides the overlay (settings.ts:905–914); `working` is discarded with no dirty-check, and next open reloads fresh via `structuredClone` (897).
- **Fix:** Track a dirty flag; if dirty, intercept Esc/backdrop/Cancel with a "Discard changes?" confirm using the existing `.confirm-box` component.

### [P2] No save feedback on the common path
- **Why it matters:** The commit is the highest-stakes moment and the interface goes silent there.
- **Evidence:** A successful non-restart save just `closeSettings()` — the toast fires only when `restartRequired` is true (settings.ts:880–883). The Save button is not disabled during the `await` and has no pending state, so a double-click re-invokes (876–887).
- **Fix:** Always toast "Settings saved" on success; disable + relabel Save ("Saving…") while `save_config` is in flight.

### [P2] No input validation or feedback
- **Why it matters:** Silent wrong state is the worst failure mode for a config tool — an operator can set `conversation.speed` to 99 (max 4) or a negative timeout and it saves clean; or blank a field, see it empty, and unknowingly keep the old value.
- **Evidence:** `min`/`max`/`step` are set as HTML attributes only (settings.ts:299–301) — spinner hints, not enforced. The handler stores any parsable number (311–312); blanking a required number silently no-ops (307–309). No inline error messaging anywhere.
- **Fix:** Clamp to `min`/`max` on blur, or mark the field `aria-invalid` with a `.settings-field-error` line and block Save while any field is invalid.

### [P3] Radius + font token drift (detector-confirmed)
- **Why it matters:** The difference between "uses the design system" and "eyeballed near it."
- **Evidence:** 7 off-scale radii in the settings block (style.css:2241, 2320, 2350, 2389, 2405, 2420, 2451) against the 7/10/12 scale. Separately, `.section-name` (2401) and `.section-grid input` (2446) set no `font-family`, so machine data (PR-label CSV, reviewer logins, numeric WIP limit) renders in sans there while the same data types render mono in the main panel.
- **Fix:** Replace raw radii with `var(--radius-1)`; add `font-family: var(--font-mono)` to section-grid text/number inputs.

## Persona Red Flags

**Alex (power user):** Can't save from the keyboard — must mouse to the footer (settings.ts:456). No autofocus, no arrow-key category nav — every session opens with a Tab hunt. Blanks a required number to clear it; it silently reverts (307–309), so he trusts a value that isn't set. Saves and gets no confirmation (880) — has to reopen to verify.

**Sam (accessibility / keyboard):** No visible focus ring on any settings button or toggle — can't tell where focus is. Toggles have no accessible name (unlabeled checkbox; field label not associated, 533/544). The segmented control is a row of `<button>`s, not a `radiogroup`, with no `aria-pressed` (572–584). Focus lost to `<body>` after every master-toggle flip (291). Touch/hit targets are small: toggle 36×20px (2302), section icons 24×24px (2424), `.row-action` ~15px tall (1508).

**Riley (stress tester):** Out-of-range numbers accepted silently (310–312). Rapid master-toggle spam triggers full panel rebuilds each time (500) — focus + scroll thrash. Credit where due: the empty-search case is handled ("No matches" + emptied panel, 470–476, 503).

## Minor Observations

- Footer order (Cancel left, Save right, settings.ts:459) matches macOS convention — keep it, but give Save visual primacy; today Cancel and Save share the identical `.row-action` class, so nothing marks the commit.
- Nav icons and the `⌕` search glyph are Unicode symbols with meaning but no text fallback for a screen reader (201–215, 430).
- `overlay-in` is correctly disabled under `prefers-reduced-motion` (style.css:4346) — good hygiene.
- Low-emphasis small text is dense: 11px on `--text-dim` for `.settings-field-desc`, `.settings-note`, `.settings-panel-heading`, `.section-field-label`, and placeholders — the highest contrast-risk pairing on the pane; measure it against WCAG AA.
- Section cards give no "which rule matched / is this valid" feedback — a user building overlapping rules gets no precedence cue beyond the note text.

## Questions to Consider

1. Appearance applies and persists live via `setMode()` (settings.ts:577) while every config field is buffered behind Save — so "Cancel" is a lie on the Appearance tab. Should Appearance leave the buffered footer entirely, or should config also autosave?
2. This pane imitates macOS System Settings, which autosaves per field. For a dense expert tool, is a modal Save/Cancel the right model at all — or is it ceremony that creates the silent-save and silent-discard problems you now have?
3. Thirteen categories, and search is the only fast way through them with no keyboard list nav. Is the icon list load-bearing navigation, or has search quietly become the real UI while the nav is decoration?
