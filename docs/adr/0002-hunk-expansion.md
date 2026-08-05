# ADR 0002: Hunk expansion in the review diff

Date: 2026-08-05
Status: Accepted

## Context

ADR 0001 (point 5) replaced the review diff renderer with @pierre/diffs but
left hunk expansion out of scope: the renderer shows only the snapshot's
hunks, with the `line-info` hunk separators named as the mount point for
future expansion arrows.

Pierre supports expansion natively. A diff parsed from patch text is a
**partial diff** (`isPartial: true`); when a `loadDiffFiles` callback is
configured, Pierre calls it eagerly on first render of a changed/renamed
file, **hydrates** the metadata in place with both sides' full contents, and
from then on renders expansion arrows in the separators and handles the
clicks itself (`expandHunk`). Added/deleted files never call the loader —
their one existing side is already fully present in the patch. Loader
failures are caught and logged; the file simply stays partial (no arrows).

On the backend, the plumbing already exists: `read_review_image` wraps
`svc.fetch_diff_blob(sid, side, path)`, which reads the working tree for the
new side and the review-base blob for the old side (smudging git-LFS
pointers).

## Decision

Wire Pierre's native expansion up end-to-end. Resolved points from the
design grill:

1. **Eager per-file loading.** Accept Pierre's timing: contents are fetched
   when a changed/renamed file is first rendered, not when an arrow is
   clicked. Reads are local and scoped to the file being viewed. Loaded
   contents are cached per path; the cache resets on snapshot refresh
   (same lifecycle as `parsedCache`/`imageCache`).
2. **New thin command `read_review_file(id, path, side) -> String`** in
   `src-tauri/src/review.rs`, mirroring `read_review_image` over the same
   `fetch_diff_blob` service call, converting with `String::from_utf8_lossy`
   (files reaching this path already diffed as text; a stray invalid byte
   degrades to a replacement character rather than failing hydration).
3. **Arrows only, Pierre defaults.** No `expandUnchanged` toggle, no
   expand-all button, default `expansionLineCount` (GitHub-style chunked
   expansion). No new chrome or keybindings; expansion is mouse-only in
   this PR (the j/k cursor keeps walking hunk lines).
4. **Expanded context lines are not commentable.** Line clicks and drags on
   expanded rows are ignored (no-op); the comment pipeline continues to map
   selections onto the snapshot's hunk lines only. Expanded context is for
   reading; comments target the change. Commentable context is a
   self-contained follow-up if it proves wanted.
5. **Stale-content validation before hydration.** The snapshot's hunks are
   frozen at open/refresh time but the new side reads the live working tree,
   which the agent may have modified since. Before handing contents to
   Pierre, verify each hunk's context/addition lines match the loaded
   new-side content at their claimed line numbers; on mismatch, throw inside
   the loader — Pierre catches it and the file stays unexpandable rather
   than rendering shifted context. A manual refresh recovers. (The old side
   is immutable and needs no check.)
6. **No large-file guard.** Files here already went through CC's text-diff
   pipeline at snapshot time, and Pierre virtualizes rendering. A size cap
   is speculative tuning; add one only if a real file ever hurts.
7. **Tests per the ADR 0001 pattern.** Vitest units for the pure parts
   (loader glue: side→path mapping incl. renames, pure renames returning
   `oldFile: null`; stale-content validation match/mismatch cases). iwft
   flows with `read_review_file` in the TauriSimulator: arrows appear,
   expansion renders correct content, expanded rows don't open the
   composer, drifted content yields no arrows. No Rust test — the command
   is thin delegation, like `read_review_image`.
8. **One PR** on branch `hunk-expansion` off `main`.

## Consequences

- Expansion state lives on Pierre's hydrated metadata object, whose identity
  is preserved by the per-path parse cache — so expansion survives
  re-renders (theme, annotations). Snapshot refresh resets the cache, so
  **saving or deleting a comment collapses any expanded context**. Accepted:
  the refreshed diff may differ, and stale expansion state would lie.
- Two extra local reads (worktree file + base blob) per changed/renamed file
  view, cached per snapshot.
- A drifted working tree silently withholds arrows for the affected file
  until refresh — by design, but worth remembering when arrows "go missing".
