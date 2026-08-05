# CC-GUI — domain context

Glossary of terms this project uses deliberately. Skills and docs should use
these terms as defined here, not synonyms.

## Glossary

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
