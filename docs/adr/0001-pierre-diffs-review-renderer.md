# ADR 0001: Replace the review diff renderer with @pierre/diffs

Date: 2026-08-01
Status: Accepted

## Context

The review view's text-diff renderer is hand-rolled in `src/review.ts`: DOM
built line-by-line from the snapshot's structured hunks, syntax-highlighted by
a bespoke Shiki setup (26 bundled languages, per-file token cache, theme
loaders). It works, but every presentation improvement (word-level inline
diffs, split view, hunk expansion) would be built from scratch.

[@pierre/diffs](https://diffs.com) (Apache-2.0, from Pierre) renders diffs from
patch text with a vanilla JS API — no React runtime needed. A throwaway
prototype (branch `pierre-diffs`, `src/review/prototype-pierre.ts`) put four
variants behind a dev-only switcher on the live review pane. Verdict: the
**bars** presentation wins — unified view, `diffIndicators: 'bars'`,
`disableBackground: true`, word-level inline diff.

## Decision

Fully replace the hand-rolled text-diff renderer with @pierre/diffs in the
bars presentation. Resolved points from the design grill:

1. **Parity bar: workflow parity.** Line selection, the inline composer,
   comment cards, and orphan/stranded comment handling must work before the
   old renderer is deleted. Keyboard/a11y behaviours are re-expressed in
   Pierre's idiom rather than cloned exactly; a mouse-free comment path is
   preserved (it's documented in the `?` overlay and README).
2. **Bundle: accept Pierre's full Shiki language set** (~270 lazy chunks on
   disk; only viewed languages load at runtime) — a desktop app can afford
   the bundle size, and languages our 26-entry map never covered get
   highlighting for free. The Pierre module is `import()`ed on first review
   open so the main chunk stays lean. Our hand-rolled Shiki setup is deleted.
3. **Custom themes: full support.** Built-in themes pass their bundled Shiki
   id through; custom themes register their TextMate object via
   `registerCustomTheme`. No visual regression for custom-theme users.
4. **Comment UI: reuse the existing cards and composer** through Pierre's
   `DiffLineAnnotation` + `renderAnnotation`. Anchoring convention is
   unchanged (range-end line on the comment's side). No restyle in this PR.
5. **Hunk expansion: out of scope.** Render only the snapshot's hunks, as
   today. Expansion needs full file contents (a new Rust command feeding
   Pierre's `loadDiffFiles`) and is the first follow-up PR.
6. **Hard cutover.** The PR deletes the old hunk renderer, Shiki loaders, and
   the prototype switcher. No runtime escape hatch — odd diff shapes are
   covered by tests, and the old code stays in git history and on the
   `pierre-diffs` capture branch.
7. **Pane chrome:** Pierre's per-file header is disabled (the sidebar owns
   file identity); hunk separators use `line-info` (reads better than raw
   `@@` specs and is the mount point for future expansion arrows).
8. **Shape: one PR** on branch `pierre-diff-renderer` off `main`. Tests:
   Vitest units for the pure parts (patch reconstruction from hunks across
   statuses/renames/no-EOF-newline, comment↔annotation mapping, draft
   building); iwft flows for select → comment → delete → apply on all file
   statuses, asserting through Pierre's shadow DOM.

Out of Pierre's hands either way: image diffs (juxtapose slider) and
stranded-file comment sections keep their existing custom rendering.

## Consequences

- Presentation features (split view, indicators, word-level diffs, future
  hunk expansion) come from a maintained library instead of bespoke DOM code;
  ~200 lines of Shiki plumbing in `review.ts` go away.
- The diff pane moves inside a `<diffs-container>` shadow root. Comment-card
  CSS must reach into it (inject into the shadow root or use light-DOM
  slots), and Playwright assertions must pierce it. Known risk, scoped fixes.
- CC's structured hunks are re-serialized to unified patch text for Pierre's
  `parsePatchFiles` — a round-trip that must stay faithful (unit-tested).
- Bundle grows by several MB of lazy language chunks (disk only).
- New dependency surface: @pierre/diffs pins its own Shiki; version bumps of
  either are coupled through it.
