# CC-GUI — domain context

Glossary of terms this project uses deliberately. Skills and docs should use
these terms as defined here, not synonyms.

## Glossary

### Review

- **Review Snapshot** — the parsed base→working-tree diff plus re-anchored
  comments for one session, frozen at open/refresh time. Everything the
  review pane shows derives from it. _Avoid_: diff state, review data.
- **Partial Diff** — a file's diff knowing only the lines its hunks mention,
  as parsed from patch text. The opposite of a hydrated diff.
  _Avoid_: incomplete diff, patch-only diff.
- **Hydration** — upgrading a partial diff in place with the full contents of
  both file sides, making expansion possible. _Avoid_: loading, enrichment.
- **Expansion** — revealing unchanged file lines between or around a file's
  hunks. Expanded context is read-only — comments target the change, not the
  surroundings. _Avoid_: unfolding, context reveal.
- **Snapshot Staleness** — the drift between a review snapshot and the live
  working tree, which the agent may have modified since open/refresh.
  Anything combining snapshot data with live reads must tolerate it.
  _Avoid_: race, desync.
- **Orphan Comment** — a staged comment whose anchor line is no longer
  rendered in the current diff. Shown in a separate section rather than
  inline. _Avoid_: stranded comment (reserved for stranded *files*),
  dangling comment.

### Markdown viewer

- **Markdown viewer** — the `Cmd+M` distraction-free reader
  (`src/markdownViewer.ts`) over the active session's repo docs. Distinct
  from the **file explorer** (`Cmd+E`, browses all files to drop `@path`
  references) and the **review view** (diff + comments).
- **Relevance ladder** — the priority order deciding what ⌘M opens:
  session-changed docs (by mtime) → `README.md` → the picker. See ADR-0007.
- **Session-changed docs** — `.md` files changed on the session's branch:
  the merge-base diff against main **plus** uncommitted working-tree
  changes.
- **Last-viewed rule** — reopening the viewer returns to the file you were
  reading, unless a session-changed doc is newer than that view (then the
  relevance ladder wins). See ADR-0007.
- **Picker** — the viewer's fuzzy file list (`/` or clicking the file bar).
  Default order is relevance, not alphabetical.
- **Live reload** — the viewer re-reads the displayed file on a short poll
  while open and re-renders in place, preserving scroll. See ADR-0004.

## Decisions

Architectural decisions live in `docs/adr/`.
