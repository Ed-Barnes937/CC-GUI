# Markdown viewer — production implementation plan

Outcome of the 2026-08-02 grilling session. Decisions are recorded as ADRs
0001–0005 (`docs/adr/`); terms as used here are defined in `CONTEXT.md`.

**Scope:** the full vision — relative images, live reload, syntax
highlighting, and session-aware ⌘M. Programmatic open-from-session channel
is **out of scope** (session-aware ⌘M replaces it; auto-opening UI on agent
action is a focus-stealing/consent question deferred to its own round).

**Starting point:** branch `markdown` (prototype fold-in, commits 84b048f +
7d0e703): `src/markdownViewer.ts`, commands in `src-tauri/src/files.rs`,
iwft scenario `scenarios/markdownViewer/`. PR #95 was closed as
prototype-stage; PR 1 below supersedes it.

## Delivery: a stack of three PRs

### PR 1 — reader, production-grade (branch `markdown`, base `main`)

- **Pin `@tanstack/markdown`** to the exact version, drop the `^` range
  (ADR-0003).
- **Relative images** (ADR-0006): new `read_session_image(session_id,
  rel_path)` command in `files.rs` (canonicalize + worktree-escape guard,
  base64 return, mirroring `read_review_image`). Frontend post-processes
  `<img>`: relative `src` → resolve via `resolveRelative` against the doc's
  dir → `data:` URI. MIME whitelist `png/jpg/jpeg/gif/svg/webp`; missing /
  non-whitelisted / >10MB → quiet broken-image placeholder. Remote `http(s)`
  images untouched (CSP is null; they already load).
- **Shiki highlighting** (ADR-0005): post-process rendered
  `<pre><code class="language-x">` blocks with the existing theme→Shiki
  mapping from the review view. One contained function; renderer stays
  swappable.
- **Ranked listing + visible cap**: `list_markdown_files` returns
  `(path, mtime)` for all candidates (walk already skips
  `node_modules`/`target`/hidden); the returned list is capped at 500
  **after** sorting, and the picker shows a non-selectable final row
  ("500 of N — keep typing to narrow") when truncated. (Full relevance
  ranking with changed-flags arrives in PR 3; PR 1 sorts by mtime.)

### PR 2 — live reload (stacked on PR 1)

- **Polling** (ADR-0004): while a file is displayed, re-invoke
  `read_session_file` every ~1.5s; re-render only when content changed.
- **Scroll-preserving re-render**: keep the reading position stable (no
  flash, no jump) while an agent appends to the doc.
- Poll only while the viewer is open and the window is visible; stop on
  close. A read error during polling keeps the last rendering (no error
  flash mid-read).
- Never auto-navigate: a *new* file appearing (or becoming more relevant)
  while reading does not switch the document — it surfaces via the picker.
- The picker refreshes its listing each time it opens (existing behaviour,
  now guaranteed): new files the agent created appear without reopening the
  viewer.

### PR 3 — session-aware ⌘M (stacked on PR 2)

- **Relevance ladder** (ADR-0007): session-changed `.md` (merge-base diff +
  uncommitted, most recent mtime first) → `README.md` → picker.
  Backend: listing gains a changed-on-branch flag per file; the branch diff
  reuses CC's existing review diff machinery.
- **Last-viewed rule** (ADR-0007): reopening returns to the last-viewed
  file unless a session-changed doc is newer than that view. Last-viewed
  state is **in-memory per app run**, keyed by session id (not persisted —
  restarts fall back to the ladder, which is the right default anyway).
- **Picker relevance order** (ADR-0007): default order = changed-first by
  mtime, then rest by mtime; typing filters by subsequence with relevance
  breaking ties.
- **`view-plan` skill rewrite**: drop the pick-the-file instruction and the
  "no programmatic channel" caveat; the pointer becomes "press ⌘M — it
  opens on this doc".
- Help overlay (`src/help.ts`) + README keyboard table updated for any
  behaviour change (per repo convention).

## Testing

Each PR extends the iwft scenario (`scenarios/markdownViewer/`) against the
simulated backend, per the existing pattern (stateful fakes, assert state):

- PR 1: relative image swapped to `data:` URI; broken image → placeholder;
  highlighted code block present; truncation row shown when seed exceeds cap.
- PR 2: seed content change → document updates in place, scroll retained.
- PR 3: seeded changed-flags → ⌘M lands on the changed doc; last-viewed
  rule; picker ordering.

`npm run typecheck`, `cargo fmt`, `cargo clippy` green per PR.

## Deferred / follow-ups

- Programmatic open-from-session channel (own design round; consent/focus
  UX).
- Watcher-based reload (`notify`) only if a future feature needs instant or
  repo-wide events (ADR-0004).
- Renderer swap (`marked` etc.) only if `@tanstack/markdown` stagnates
  (ADR-0003).
