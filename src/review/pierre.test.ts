import { describe, expect, it } from "vitest";
import type { Comment, FileDiff, Hunk } from "./model";
import {
  assertContentMatchesHunks,
  buildPatch,
  lineAnchor,
  loaderPaths,
  selectionToFlatRange,
  splitComments,
  toLoadedFiles,
  type PartialFileMeta,
} from "./pierre";

function hunk(over: Partial<Hunk> = {}): Hunk {
  return {
    old_start: 1,
    old_lines: 3,
    new_start: 1,
    new_lines: 4,
    header: "",
    lines: [
      { origin: "context", old_lineno: 1, new_lineno: 1, content: "alpha" },
      { origin: "deletion", old_lineno: 2, new_lineno: null, content: "beta old" },
      { origin: "addition", old_lineno: null, new_lineno: 2, content: "beta new" },
      { origin: "addition", old_lineno: null, new_lineno: 3, content: "gamma" },
      { origin: "context", old_lineno: 3, new_lineno: 4, content: "delta" },
    ],
    ...over,
  };
}

function file(over: Partial<FileDiff> = {}): FileDiff {
  return {
    old_path: "notes.txt",
    new_path: "notes.txt",
    status: "modified",
    added: 2,
    removed: 1,
    hunks: [hunk()],
    binary: null,
    ...over,
  };
}

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    file: "notes.txt",
    side: "new",
    line_range: [2, 2],
    snippet: "beta new",
    comment: "hm",
    status: "staged",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// ---------------------------------------------------------------- buildPatch

describe("buildPatch", () => {
  it("reconstructs a modified file's unified patch verbatim", () => {
    expect(buildPatch(file())).toBe(
      [
        "diff --git a/notes.txt b/notes.txt",
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -1,3 +1,4 @@",
        " alpha",
        "-beta old",
        "+beta new",
        "+gamma",
        " delta",
        "",
      ].join("\n"),
    );
  });

  it("marks an added file with /dev/null on the old side", () => {
    const f = file({
      status: "added",
      hunks: [
        hunk({
          old_start: 0,
          old_lines: 0,
          new_start: 1,
          new_lines: 1,
          lines: [{ origin: "addition", old_lineno: null, new_lineno: 1, content: "hi" }],
        }),
      ],
    });
    const patch = buildPatch(f);
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/notes.txt");
    expect(patch).toContain("@@ -0,0 +1,1 @@");
  });

  it("marks a deleted file with /dev/null on the new side", () => {
    const f = file({
      status: "deleted",
      hunks: [
        hunk({
          old_start: 1,
          old_lines: 1,
          new_start: 0,
          new_lines: 0,
          lines: [{ origin: "deletion", old_lineno: 1, new_lineno: null, content: "bye" }],
        }),
      ],
    });
    const patch = buildPatch(f);
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("--- a/notes.txt");
    expect(patch).toContain("+++ /dev/null");
  });

  it("emits rename headers with both paths", () => {
    const f = file({ status: "renamed", old_path: "old.txt", new_path: "new.txt" });
    const patch = buildPatch(f);
    expect(patch).toContain("diff --git a/old.txt b/new.txt");
    expect(patch).toContain("rename from old.txt");
    expect(patch).toContain("rename to new.txt");
    expect(patch).toContain("--- a/old.txt");
    expect(patch).toContain("+++ b/new.txt");
  });

  it("keeps the hunk's function-context header", () => {
    const f = file({ hunks: [hunk({ header: "fn main()" })] });
    expect(buildPatch(f)).toContain("@@ -1,3 +1,4 @@ fn main()");
  });

  it("emits line content verbatim (CC already strips the no-EOF marker)", () => {
    // claude-commander's review_diff drops "\ No newline at end of file" from
    // content lines, so the round trip never re-emits it — content is verbatim.
    const f = file({
      hunks: [
        hunk({
          old_lines: 1,
          new_lines: 1,
          lines: [
            { origin: "deletion", old_lineno: 1, new_lineno: null, content: "x = 1" },
            { origin: "addition", old_lineno: null, new_lineno: 1, content: "x = 2" },
          ],
        }),
      ],
    });
    expect(buildPatch(f)).toContain("-x = 1\n+x = 2\n");
    expect(buildPatch(f)).not.toContain("\\ No newline");
  });

  it("renders every hunk of a multi-hunk file", () => {
    const f = file({
      hunks: [
        hunk(),
        hunk({
          old_start: 10,
          old_lines: 1,
          new_start: 11,
          new_lines: 1,
          lines: [{ origin: "context", old_lineno: 10, new_lineno: 11, content: "tail" }],
        }),
      ],
    });
    const patch = buildPatch(f);
    expect(patch).toContain("@@ -1,3 +1,4 @@");
    expect(patch).toContain("@@ -10,1 +11,1 @@");
  });
});

// ------------------------------------------------------ selectionToFlatRange

describe("selectionToFlatRange", () => {
  // Flat order in the default file:
  // 0 context(1,1) · 1 deletion(2,-) · 2 addition(-,2) · 3 addition(-,3) · 4 context(3,4)

  it("maps a single addition line", () => {
    expect(selectionToFlatRange(file(), { start: 2, side: "additions", end: 2 })).toEqual([2, 2]);
  });

  it("maps a single deletion line by its old number", () => {
    expect(selectionToFlatRange(file(), { start: 2, side: "deletions", end: 2 })).toEqual([1, 1]);
  });

  it("maps a context line via the additions side (new number)", () => {
    expect(selectionToFlatRange(file(), { start: 4, side: "additions", end: 4 })).toEqual([4, 4]);
  });

  it("maps a cross-side drag (deletion anchor to addition end)", () => {
    const sel = { start: 2, side: "deletions" as const, end: 3, endSide: "additions" as const };
    expect(selectionToFlatRange(file(), sel)).toEqual([1, 3]);
  });

  it("normalizes an upward drag so start ≤ end", () => {
    const sel = { start: 3, side: "additions" as const, end: 1, endSide: "additions" as const };
    expect(selectionToFlatRange(file(), sel)).toEqual([0, 3]);
  });

  it("prefers the deletion line when a context line shares the old number", () => {
    // old 2 exists only on the deletion here, but make a file where a context
    // line shares its number with nothing else to check the fallback too.
    const f = file({
      hunks: [
        hunk({
          lines: [
            { origin: "context", old_lineno: 2, new_lineno: 2, content: "ctx" },
            { origin: "deletion", old_lineno: 3, new_lineno: null, content: "gone" },
          ],
        }),
      ],
    });
    // deletions:3 → the deletion line; deletions:2 → falls back to the context line.
    expect(selectionToFlatRange(f, { start: 3, side: "deletions", end: 3 })).toEqual([1, 1]);
    expect(selectionToFlatRange(f, { start: 2, side: "deletions", end: 2 })).toEqual([0, 0]);
  });

  it("returns null when an endpoint matches no rendered line", () => {
    expect(selectionToFlatRange(file(), { start: 99, side: "additions", end: 99 })).toBeNull();
  });

  it("treats a missing side as additions", () => {
    expect(selectionToFlatRange(file(), { start: 2, end: 3 })).toEqual([2, 3]);
  });
});

// -------------------------------------------------------------- splitComments

describe("splitComments", () => {
  it("maps a new-side comment to an additions annotation at its range end", () => {
    const { annotations, orphans } = splitComments([comment()], "notes.txt", file());
    expect(orphans).toEqual([]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({ side: "additions", lineNumber: 2 });
    expect(annotations[0].metadata.id).toBe("c1");
  });

  it("maps an old-side comment to a deletions annotation", () => {
    const c = comment({ side: "old", line_range: [2, 2] });
    const { annotations, orphans } = splitComments([c], "notes.txt", file());
    expect(orphans).toEqual([]);
    expect(annotations[0]).toMatchObject({ side: "deletions", lineNumber: 2 });
  });

  it("anchors a multi-line comment at the end of its range", () => {
    const c = comment({ line_range: [2, 3] });
    const { annotations } = splitComments([c], "notes.txt", file());
    expect(annotations[0].lineNumber).toBe(3);
  });

  it("orphans a comment whose anchor line left the diff", () => {
    const c = comment({ line_range: [99, 99] });
    const { annotations, orphans } = splitComments([c], "notes.txt", file());
    expect(annotations).toEqual([]);
    expect(orphans).toEqual([c]);
  });

  it("ignores comments for other files", () => {
    const c = comment({ file: "elsewhere.txt" });
    const { annotations, orphans } = splitComments([c], "notes.txt", file());
    expect(annotations).toEqual([]);
    expect(orphans).toEqual([]);
  });

  it("an old-side comment can anchor to a context line's old number", () => {
    const c = comment({ side: "old", line_range: [1, 1] });
    const { annotations, orphans } = splitComments([c], "notes.txt", file());
    expect(orphans).toEqual([]);
    expect(annotations[0]).toMatchObject({ side: "deletions", lineNumber: 1 });
  });
});

// -------------------------------------------------- loaderPaths / toLoadedFiles

describe("loaderPaths", () => {
  const meta = (over: Partial<PartialFileMeta> = {}): PartialFileMeta => ({
    name: "notes.txt",
    type: "change",
    ...over,
  });

  it("reads both sides at the same path for a plain change", () => {
    expect(loaderPaths(meta())).toEqual({ oldPath: "notes.txt", newPath: "notes.txt" });
  });

  it("reads the old side at the pre-rename path for a changed rename", () => {
    const m = meta({ name: "new.txt", prevName: "old.txt", type: "rename-changed" });
    expect(loaderPaths(m)).toEqual({ oldPath: "old.txt", newPath: "new.txt" });
  });

  it("skips the old side for a pure rename", () => {
    const m = meta({ name: "new.txt", prevName: "old.txt", type: "rename-pure" });
    expect(loaderPaths(m)).toEqual({ oldPath: null, newPath: "new.txt" });
  });
});

describe("toLoadedFiles", () => {
  it("returns both sides for a changed file", () => {
    expect(toLoadedFiles({ name: "notes.txt", type: "change" }, "old stuff", "new stuff")).toEqual({
      oldFile: { name: "notes.txt", contents: "old stuff" },
      newFile: { name: "notes.txt", contents: "new stuff" },
    });
  });

  it("names each side of a rename by its own path", () => {
    const m: PartialFileMeta = { name: "new.txt", prevName: "old.txt", type: "rename-changed" };
    expect(toLoadedFiles(m, "old stuff", "new stuff")).toEqual({
      oldFile: { name: "old.txt", contents: "old stuff" },
      newFile: { name: "new.txt", contents: "new stuff" },
    });
  });

  it("returns oldFile null for a pure rename", () => {
    const m: PartialFileMeta = { name: "new.txt", prevName: "old.txt", type: "rename-pure" };
    expect(toLoadedFiles(m, null, "contents")).toEqual({
      oldFile: null,
      newFile: { name: "new.txt", contents: "contents" },
    });
  });
});

// ------------------------------------------------- assertContentMatchesHunks

describe("assertContentMatchesHunks", () => {
  // The default file's new side: 1 alpha · 2 beta new · 3 gamma · 4 delta.
  const matching = "alpha\nbeta new\ngamma\ndelta\n";

  it("accepts content whose hunk lines are unchanged", () => {
    expect(() => assertContentMatchesHunks(file(), matching)).not.toThrow();
  });

  it("accepts extra lines beyond the hunks (the expandable region)", () => {
    expect(() => assertContentMatchesHunks(file(), matching + "epsilon\nzeta\n")).not.toThrow();
  });

  it("throws when a context line drifted", () => {
    const drifted = "alpha\nbeta new\ngamma\ndelta CHANGED\n";
    expect(() => assertContentMatchesHunks(file(), drifted)).toThrow(/notes\.txt:4/);
  });

  it("throws when an addition line drifted", () => {
    const drifted = "alpha\nbeta CHANGED\ngamma\ndelta\n";
    expect(() => assertContentMatchesHunks(file(), drifted)).toThrow(/notes\.txt:2/);
  });

  it("throws when the file shrank below a hunk's claimed lines", () => {
    expect(() => assertContentMatchesHunks(file(), "alpha\n")).toThrow(/stale/);
  });

  it("ignores deletion lines (they live on the immutable old side)", () => {
    // "beta old" is nowhere in the new content — that must not trip the check.
    expect(() => assertContentMatchesHunks(file(), matching)).not.toThrow();
  });
});

// ------------------------------------------------------------ lineAnchor

describe("lineAnchor", () => {
  it("anchors on the new number for additions and context lines", () => {
    const lines = file().hunks[0].lines;
    expect(lineAnchor(lines[2])).toEqual({ side: "additions", lineNumber: 2 });
    expect(lineAnchor(lines[4])).toEqual({ side: "additions", lineNumber: 4 });
  });

  it("anchors on the old number for deletion lines", () => {
    const lines = file().hunks[0].lines;
    expect(lineAnchor(lines[1])).toEqual({ side: "deletions", lineNumber: 2 });
  });
});
