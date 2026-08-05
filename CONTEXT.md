# CC-GUI

Desktop GUI for claude-commander: session management, terminals, and code
review for agent-driven worktrees. This glossary pins the review-domain
vocabulary; decisions live in `docs/adr/`.

## Language

### Review

**Review Snapshot**:
The parsed base→working-tree diff plus re-anchored comments for one session,
frozen at open/refresh time. Everything the review pane shows derives from it.
_Avoid_: diff state, review data

**Partial Diff**:
A file's diff knowing only the lines its hunks mention, as parsed from patch
text. The opposite of a hydrated diff.
_Avoid_: incomplete diff, patch-only diff

**Hydration**:
Upgrading a partial diff in place with the full contents of both file sides,
making expansion possible.
_Avoid_: loading, enrichment

**Expansion**:
Revealing unchanged file lines between or around a file's hunks. Expanded
context is read-only — comments target the change, not the surroundings.
_Avoid_: unfolding, context reveal

**Snapshot Staleness**:
The drift between a review snapshot and the live working tree, which the
agent may have modified since open/refresh. Anything combining snapshot data
with live reads must tolerate it.
_Avoid_: race, desync

**Orphan Comment**:
A staged comment whose anchor line is no longer rendered in the current
diff. Shown in a separate section rather than inline.
_Avoid_: stranded comment (reserved for stranded *files*), dangling comment
