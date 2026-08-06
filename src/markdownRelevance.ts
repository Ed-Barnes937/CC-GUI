// Session-aware ⌘M: pure decisions over the markdown listing (ADR-0007). The
// backend hands back `(path, mtime, changed_on_branch)` and ranks nothing; the
// relevance order and the open-target ladder live here so they're plain
// functions with plain tests.

/** One entry from list_markdown_files. `mtime` is epoch seconds. */
export type MdFile = { path: string; mtime: number; changedOnBranch: boolean };

/** Where the viewer was last left for a session: the doc and when it was seen
 *  (epoch seconds). In-memory per app run — not persisted. */
export type LastViewed = { path: string; at: number };

/** Relevance order: docs changed on the session's branch first, newest mtime
 *  first within each band, path breaking ties. Also the picker's default order,
 *  so the freshly written plan is the top row before anything is typed. */
export function rankByRelevance(files: MdFile[]): MdFile[] {
  return [...files].sort(
    (a, b) =>
      Number(b.changedOnBranch) - Number(a.changedOnBranch) ||
      b.mtime - a.mtime ||
      a.path.toLowerCase().localeCompare(b.path.toLowerCase()),
  );
}

/** The doc ⌘M should open, per the ladder: branch-changed (newest) → root
 *  README → null, meaning "open straight into the picker".
 *
 *  `lastViewed` short-circuits the ladder — reopening returns to the doc you
 *  were reading — unless a branch-changed doc has been touched since that view,
 *  which is exactly the "the agent updated the plan while you were away" case. */
export function resolveTarget(files: MdFile[], lastViewed: LastViewed | null): string | null {
  const newestChanged = rankByRelevance(files).find((f) => f.changedOnBranch) ?? null;
  if (
    lastViewed &&
    files.some((f) => f.path === lastViewed.path) &&
    !(newestChanged && newestChanged.mtime > lastViewed.at)
  ) {
    return lastViewed.path;
  }
  if (newestChanged) return newestChanged.path;
  return files.find((f) => f.path.toLowerCase() === "readme.md")?.path ?? null;
}
