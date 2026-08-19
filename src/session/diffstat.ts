// The backend's git diffstat, parsed and drawn.
//
// The detail panel and the board cards both show the same add/remove bar for
// the same string, so they share the parse and the bar rather than each
// re-deriving it.

/** Parse the backend's git-style diffstat summary ("3 files changed,
 *  124 insertions(+), 38 deletions(-)"; zero clauses omitted). Null when the
 *  string isn't that shape. */
export function parseDiffStat(diffStat: string): { files: number; adds: number; dels: number } | null {
  const m = diffStat.match(
    /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/,
  );
  if (!m) return null;
  return { files: Number(m[1]), adds: Number(m[2] ?? 0), dels: Number(m[3] ?? 0) };
}

/** Proportional add/remove bar for a parsed diffstat. */
export function diffstatBar(adds: number, dels: number): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "diffstat-bar";
  const total = adds + dels;
  const a = document.createElement("span");
  a.className = "added";
  a.style.width = `${(adds / total) * 100}%`;
  const r = document.createElement("span");
  r.className = "removed";
  r.style.width = `${(dels / total) * 100}%`;
  bar.append(a, r);
  return bar;
}
