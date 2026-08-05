# ADR-0007: Session-aware ⌘M — relevance ladder for what opens

Date: 2026-08-02
Status: accepted

## Context

The feature's core promise: "the agent just updated a plan — hit ⌘M and
you're reading it." The prototype always opened `README.md`. Pure
mtime-latest is cheap but steals the slot for unrelated touches (vendored
docs, user edits elsewhere); git-filtering to docs the session's branch
changed is semantically right, and CC's review machinery already computes
that diff.

## Decision

⌘M resolves its target with a **priority ladder**:

1. `.md` files changed on the session's branch (merge-base diff **plus**
   uncommitted changes), most recent mtime first → open the top one.
2. No branch-changed docs → `README.md` if present.
3. Neither → open directly into the fuzzy picker.

**Last-viewed rule:** if the viewer was previously open on a file this
session, reopening returns to that file — *unless* a branch-changed doc has
an mtime newer than that last view, in which case the ladder wins. Keeps
"I was reading X" stable while still surfacing "the agent updated the plan
while the viewer was closed".

**Picker ordering:** the file list's default order is the same relevance
ranking (branch-changed first by mtime, then the rest by mtime) instead of
alphabetical. While typing, subsequence match filters rows and relevance
breaks ties — the freshly written plan is the top row before and during
typing.

## Consequences

- A fresh session with no doc edits behaves like the prototype (README).
- Backend: the markdown listing must return mtimes and changed-on-branch
  flags, not just paths.
- Wrong guesses are cheap: the right doc is the picker's top row.
