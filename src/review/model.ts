// Pure, DOM-free model + helpers for the review pane. Extracted from review.ts
// so they're unit-testable without the #review DOM skeleton (review.ts grabs DOM
// nodes at import time and would throw outside the app shell).
//
// Mirrors claude-commander's ReviewSnapshot (api.rs / git/review_diff.rs /
// comment/mod.rs) — all snake_case via serde.

export type LineOrigin = "context" | "addition" | "deletion";

export type DiffLine = {
  origin: LineOrigin;
  old_lineno: number | null;
  new_lineno: number | null;
  content: string;
};

export type Hunk = {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string;
  lines: DiffLine[];
};

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

/** A binary file's render kind. Internally tagged on `kind` by serde, so an
 *  image carries its MIME alongside the discriminant. */
export type BinaryKind = { kind: "image"; mime: string } | { kind: "other" };

/** Metadata for a binary file's diff. Bytes are lazy-loaded via
 *  `read_review_image`; `old_*`/`new_*` are null on the missing side. */
export type BinaryInfo = {
  kind: BinaryKind;
  old_oid: string | null;
  new_oid: string | null;
  old_size: number | null;
  new_size: number | null;
};

export type FileDiff = {
  old_path: string;
  new_path: string;
  status: FileStatus;
  added: number;
  removed: number;
  hunks: Hunk[];
  /** Present when the file is binary (no textual hunks); null for text. */
  binary: BinaryInfo | null;
};

export type Comment = {
  id: string;
  file: string;
  side: "old" | "new";
  line_range: [number, number];
  snippet: string;
  comment: string;
  status: "staged" | "drifted" | "applied";
  created_at: string;
};

export type ReviewSnapshot = {
  base: string;
  diff: { files: FileDiff[] };
  comments: Comment[];
  /** Display paths of files marked reviewed (read); their row is banded. */
  reviewed: string[];
};

export type ApplyOutcome =
  | { outcome: "nothing" }
  | { outcome: "blocked"; drifted: string[] }
  | { outcome: "applied"; path: string; count: number }
  | { outcome: "deferred"; path: string; count: number };

/** The path a file is shown under: deletions keep their old path, everything
 *  else uses the new path. */
export function displayPath(f: FileDiff): string {
  return f.status === "deleted" ? f.old_path : f.new_path;
}

/** The MIME of a file shown as an image diff, or null if it isn't a renderable
 *  image. Driven by the snapshot's binary metadata, so it covers both LFS and
 *  directly-committed images. */
export function imageMime(f: FileDiff): string | null {
  return f.binary?.kind.kind === "image" ? f.binary.kind.mime : null;
}

export const STATUS_LETTER: Record<FileStatus, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export type Draft = {
  side: "old" | "new";
  lineRange: [number, number];
  snippet: string;
};

/**
 * Build a comment draft from the selected lines, mirroring the TUI's
 * `build_draft`: the New side wins unless the selection is purely deletions,
 * and the line range / snippet come from that side's lines only. Returns null
 * when the selection has no usable line on the chosen side.
 */
export function buildDraft(lines: DiffLine[]): Draft | null {
  const side = lines.some((l) => l.new_lineno !== null) ? "new" : "old";
  const collected = lines
    .map((l) => ({ n: side === "new" ? l.new_lineno : l.old_lineno, content: l.content }))
    .filter((x): x is { n: number; content: string } => x.n !== null);
  if (!collected.length) return null;
  const nums = collected.map((x) => x.n);
  return {
    side,
    lineRange: [Math.min(...nums), Math.max(...nums)],
    snippet: collected.map((x) => x.content).join("\n"),
  };
}

export function describeOutcome(o: ApplyOutcome): string {
  switch (o.outcome) {
    case "nothing":
      return "Nothing to apply";
    case "blocked":
      return `Blocked: ${o.drifted.length} drifted comment(s) — review or delete them first`;
    case "applied":
      return `Sent ${o.count} comment(s) to the agent`;
    case "deferred":
      return `Agent not ready — brief written to ${o.path}; re-apply later`;
  }
}
