// Pure, DOM-free glue between CC's structured review snapshot and @pierre/diffs.
// Kept import-light (structural copies of Pierre's little shapes rather than the
// library types) so it unit-tests without loading the renderer.

import type { Comment, DiffLine, FileDiff } from "./model";

/** Pierre's annotation/selection side in a diff. */
export type PierreSide = "deletions" | "additions";

/** Structural copy of Pierre's SelectedLineRange (unified view semantics:
 *  deletion rows report the old number on `deletions`, additions and context
 *  rows the new number on `additions`; `endSide` defaults to `side`). */
export type PierreSelection = {
  start: number;
  side?: PierreSide;
  end: number;
  endSide?: PierreSide;
};

/** A comment mapped onto Pierre's DiffLineAnnotation shape. */
export type CommentAnnotation = {
  side: PierreSide;
  lineNumber: number;
  metadata: Comment;
};

/**
 * Rebuild a unified git patch for one file from the snapshot's structured
 * hunks — @pierre/diffs parses patch text; CC only hands us parsed hunks.
 * Content lines are emitted verbatim (CC already strips the no-EOF marker).
 */
export function buildPatch(f: FileDiff): string {
  const out: string[] = [];
  out.push(`diff --git a/${f.old_path} b/${f.new_path}`);
  if (f.status === "added") out.push("new file mode 100644");
  if (f.status === "deleted") out.push("deleted file mode 100644");
  if (f.status === "renamed") out.push(`rename from ${f.old_path}`, `rename to ${f.new_path}`);
  out.push(f.status === "added" ? "--- /dev/null" : `--- a/${f.old_path}`);
  out.push(f.status === "deleted" ? "+++ /dev/null" : `+++ b/${f.new_path}`);
  for (const h of f.hunks) {
    out.push(
      `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@` +
        (h.header ? ` ${h.header}` : ""),
    );
    for (const l of h.lines) {
      const marker = { context: " ", addition: "+", deletion: "-" }[l.origin];
      out.push(marker + l.content);
    }
  }
  return out.join("\n") + "\n";
}

/** All of a file's hunk lines in render order. */
export function flatLines(f: FileDiff): DiffLine[] {
  return f.hunks.flatMap((h) => h.lines);
}

/** The flat index of the line a selection endpoint names, or -1. A deletions
 *  endpoint prefers the deletion carrying that old number but falls back to a
 *  context line sharing it; an additions endpoint matches on the new number. */
function endpointIndex(lines: DiffLine[], side: PierreSide, lineNumber: number): number {
  if (side === "deletions") {
    const del = lines.findIndex((l) => l.origin === "deletion" && l.old_lineno === lineNumber);
    if (del !== -1) return del;
    return lines.findIndex((l) => l.old_lineno === lineNumber);
  }
  return lines.findIndex((l) => l.new_lineno === lineNumber);
}

/**
 * Map a Pierre line selection onto an inclusive [start, end] index range into
 * the file's flat lines (the shape buildDraft consumes). Normalizes upward
 * drags; null when an endpoint matches no rendered line.
 */
export function selectionToFlatRange(
  file: FileDiff,
  sel: PierreSelection,
): [number, number] | null {
  const lines = flatLines(file);
  const a = endpointIndex(lines, sel.side ?? "additions", sel.start);
  const b = endpointIndex(lines, sel.endSide ?? sel.side ?? "additions", sel.end);
  if (a === -1 || b === -1) return null;
  return a <= b ? [a, b] : [b, a];
}

/**
 * Split `path`'s comments into Pierre annotations (anchor line still rendered)
 * and orphans (their anchor left the diff). Anchoring convention is unchanged:
 * a comment hangs off the range-end line on its own side.
 */
export function splitComments(
  comments: Comment[],
  path: string,
  file: FileDiff,
): { annotations: CommentAnnotation[]; orphans: Comment[] } {
  const lines = flatLines(file);
  const annotations: CommentAnnotation[] = [];
  const orphans: Comment[] = [];
  for (const c of comments) {
    if (c.file !== path) continue;
    const lineNumber = c.line_range[1];
    const present =
      c.side === "new"
        ? lines.some((l) => l.new_lineno === lineNumber)
        : lines.some((l) => l.old_lineno === lineNumber);
    if (present) {
      annotations.push({
        side: c.side === "new" ? "additions" : "deletions",
        lineNumber,
        metadata: c,
      });
    } else {
      orphans.push(c);
    }
  }
  return { annotations, orphans };
}

/** Where the inline composer hangs for a selection-end line: deletions keep
 *  their old number, everything else anchors on the new number. */
export function lineAnchor(line: DiffLine): { side: PierreSide; lineNumber: number } {
  return line.origin === "deletion"
    ? { side: "deletions", lineNumber: line.old_lineno! }
    : { side: "additions", lineNumber: line.new_lineno! };
}
