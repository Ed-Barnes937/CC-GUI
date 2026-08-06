import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed, makeReview, SESSION_ID } from "../../network/seed.testHelper";
import type { Comment, FileDiff } from "../../../review/model";

test("comment renders after saving, and the fake stores the derived draft", async ({ review }) => {
  await review.selectLine("beta new");
  await review.writeComment("this looks wrong");

  // Observable result: the comment renders (the fake returned it on refresh).
  await expect(review.commentBodies()).toHaveText(["this looks wrong"]);

  // State-based assertion on the fake: the New side won, range/snippet derived
  // from that line (the side/range derivation itself is unit-tested in model.ts).
  const stored = await review.storedComments(SESSION_ID);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    side: "new",
    line_range: [2, 2],
    snippet: "beta new",
    comment: "this looks wrong",
    status: "staged",
  });
});

test("apply sends staged comments and returns to the workspace", async ({ review }) => {
  await review.selectLine("beta new");
  await review.writeComment("nit");

  await expect(review.applyBarLocator()).toBeVisible();
  await expect(review.applySummaryText()).resolves.toBe("1 comment ready to send back to the agent");
  await expect(review.applyLocator()).toHaveText("Apply 1 comment →");
  await review.apply();

  // A successful apply clears the staged comment and closes the review,
  // returning to the workspace; the fake recorded the applied comment.
  await expect(review.paneLocator()).toBeHidden();
  // The panel tears down, so the "sent" acknowledgement lives on as a toast.
  await expect(review.toasts()).toHaveText(["Sent 1 comment(s) to the agent"]);
  const stored = await review.storedComments(SESSION_ID);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ comment: "nit", status: "applied" });
});

test("apply arms on the first press and confirms on the second", async ({ review }) => {
  await review.selectLine("beta new");
  await review.writeComment("nit");

  // First press only arms — nothing is sent yet.
  await review.armApply();
  await expect(review.applyLocator()).toHaveText("Confirm — send 1 comment");
  await expect(review.paneLocator()).toBeVisible();
  expect(await review.storedComments(SESSION_ID)).toMatchObject([{ status: "staged" }]);
});

test("an armed apply can be called off with Esc", async ({ review }) => {
  await review.selectLine("beta new");
  await review.writeComment("nit");

  await review.armApply();
  await expect(review.applyLocator()).toHaveText("Confirm — send 1 comment");

  await review.pressKey("Escape");
  // Disarmed: back to the resting label, panel still open, nothing sent.
  await expect(review.applyLocator()).toHaveText("Apply 1 comment →");
  await expect(review.paneLocator()).toBeVisible();
});

test("the diff is reviewable by keyboard: j moves a cursor, Enter opens the composer", async ({ review }) => {
  await review.pressKey("j"); // drop the line cursor onto the first line
  await expect(review.cursorLine()).toBeVisible();

  await review.pressKey("Enter"); // open a comment for the cursor line
  await expect(review.diffTextarea()).toBeVisible();
});

test("a comment can be deleted", async ({ review }) => {
  await review.selectLine("beta new");
  await review.writeComment("remove me");
  await expect(review.commentBodies()).toHaveText(["remove me"]);

  await review.deleteFirstComment();
  await expect(review.commentBodies()).toHaveCount(0);
});

test("toggling a file reviewed bands its row and persists to the fake", async ({ review }) => {
  await expect(review.reviewedRows()).toHaveCount(0);
  await expect(review.progressCountText()).resolves.toBe("0/1");

  await review.toggleReviewed("notes.txt");
  await expect(review.reviewedRows()).toHaveCount(1);
  await expect(review.progressCountText()).resolves.toBe("1/1");
  expect(await review.storedReviewed(SESSION_ID)).toEqual(["notes.txt"]);

  // Toggling again clears the mark.
  await review.toggleReviewed("notes.txt");
  await expect(review.reviewedRows()).toHaveCount(0);
  await expect(review.progressCountText()).resolves.toBe("0/1");
  expect(await review.storedReviewed(SESSION_ID)).toEqual([]);
});

test.describe("with an orphaned comment", () => {
  // A comment anchored to a line (new 99) absent from the diff's hunks: the
  // file changed under it, so it matches no rendered line.
  const orphan: Comment = {
    id: "c-orphan",
    file: "notes.txt",
    side: "new",
    line_range: [99, 99],
    snippet: "long-gone line",
    comment: "stale note",
    status: "drifted",
    created_at: "2026-01-01T00:00:00Z",
  };
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: { [SESSION_ID]: makeReview({ comments: [orphan] }) },
    },
  });

  test("renders in the trailing section and stays deletable", async ({ review }) => {
    // Without the safeguard it would match no line and silently vanish.
    await expect(review.orphanHeader()).toBeVisible();
    await expect(review.commentBodies()).toHaveText(["stale note"]);

    await review.deleteFirstComment();
    await expect(review.commentBodies()).toHaveCount(0);
    await expect(review.orphanHeader()).toBeHidden();
    expect(await review.storedComments(SESSION_ID)).toHaveLength(0);
  });
});

test.describe("with an old-side comment anchored to a context line", () => {
  // After drift, an old-side comment can end up anchored to a context line's
  // old number (old 3 = the "delta" context line). Pierre's unified rows carry
  // both numbers, so a deletions-side annotation must still render as a card
  // rather than silently vanishing or falling into the orphan section.
  const onContext: Comment = {
    id: "c-old-ctx",
    file: "notes.txt",
    side: "old",
    line_range: [3, 3],
    snippet: "delta",
    comment: "note on old context",
    status: "drifted",
    created_at: "2026-01-01T00:00:00Z",
  };
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: { [SESSION_ID]: makeReview({ comments: [onContext] }) },
    },
  });

  test("renders inline as a card, not as an orphan", async ({ review }) => {
    await expect(review.commentBodies()).toHaveText(["note on old context"]);
    await expect(review.orphanHeader()).toBeHidden();
  });
});

test.describe("with a comment on a file no longer in the diff", () => {
  // The change to gone.txt was reverted, so it isn't in the diff at all — but
  // its comment persists in the session's comment store.
  const stranded: Comment = {
    id: "c-stranded",
    file: "gone.txt",
    side: "new",
    line_range: [3, 3],
    snippet: "reverted line",
    comment: "was here",
    status: "drifted",
    created_at: "2026-01-01T00:00:00Z",
  };
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: { [SESSION_ID]: makeReview({ comments: [stranded] }) },
    },
  });

  test("is listed in a stranded section and stays deletable", async ({ review }) => {
    // gone.txt has no diff row, so it surfaces only in the stranded section.
    await expect(review.strandedRow("gone.txt")).toBeVisible();

    await review.selectFile("gone.txt");
    await expect(review.orphanHeader()).toBeVisible();
    await expect(review.commentBodies()).toHaveText(["was here"]);

    await review.deleteFirstComment();
    await expect(review.commentBodies()).toHaveCount(0);
    await expect(review.strandedRow("gone.txt")).toBeHidden();
    expect(await review.storedComments(SESSION_ID)).toHaveLength(0);
  });
});

test.describe("across file statuses", () => {
  const added: FileDiff = {
    old_path: "fresh.txt",
    new_path: "fresh.txt",
    status: "added",
    added: 2,
    removed: 0,
    binary: null,
    hunks: [
      {
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: 2,
        header: "",
        lines: [
          { origin: "addition", old_lineno: null, new_lineno: 1, content: "first line" },
          { origin: "addition", old_lineno: null, new_lineno: 2, content: "second line" },
        ],
      },
    ],
  };
  const deleted: FileDiff = {
    old_path: "legacy.txt",
    new_path: "legacy.txt",
    status: "deleted",
    added: 0,
    removed: 1,
    binary: null,
    hunks: [
      {
        old_start: 1,
        old_lines: 1,
        new_start: 0,
        new_lines: 0,
        header: "",
        lines: [{ origin: "deletion", old_lineno: 1, new_lineno: null, content: "legacy line" }],
      },
    ],
  };
  const renamed: FileDiff = {
    old_path: "before.txt",
    new_path: "after.txt",
    status: "renamed",
    added: 1,
    removed: 0,
    binary: null,
    hunks: [
      {
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 2,
        header: "",
        lines: [
          { origin: "context", old_lineno: 1, new_lineno: 1, content: "kept line" },
          { origin: "addition", old_lineno: null, new_lineno: 2, content: "renamed addition" },
        ],
      },
    ],
  };
  // makeReview()'s default diff carries the modified notes.txt; the extra
  // files cover the other three statuses so one flow spans all four.
  const modified = makeReview().diff.files[0];
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: {
        [SESSION_ID]: makeReview({ diff: { files: [added, renamed, deleted, modified] } }),
      },
    },
  });

  test("select → comment lands on the right side per status, delete works, apply sends the rest", async ({ review }) => {
    // The added file is first in the diff, so it's selected on open.
    await review.selectLine("second line");
    await review.writeComment("on added");

    // A deleted file's lines only exist on the old side.
    await review.selectFile("legacy.txt");
    await review.selectLine("legacy line");
    await review.writeComment("on deleted");

    // A renamed file renders under its new path.
    await review.selectFile("after.txt");
    await review.selectLine("renamed addition");
    await review.writeComment("on renamed");

    // And the plain modified file.
    await review.selectFile("notes.txt");
    await review.selectLine("beta new");
    await review.writeComment("on modified");

    const stored = await review.storedComments(SESSION_ID);
    expect(stored).toHaveLength(4);
    expect(stored.find((c) => c.comment === "on added")).toMatchObject({
      file: "fresh.txt",
      side: "new",
      line_range: [2, 2],
      snippet: "second line",
    });
    expect(stored.find((c) => c.comment === "on deleted")).toMatchObject({
      file: "legacy.txt",
      side: "old",
      line_range: [1, 1],
      snippet: "legacy line",
    });
    expect(stored.find((c) => c.comment === "on renamed")).toMatchObject({
      file: "after.txt",
      side: "new",
      line_range: [2, 2],
    });
    expect(stored.find((c) => c.comment === "on modified")).toMatchObject({
      file: "notes.txt",
      side: "new",
      line_range: [2, 2],
    });

    // One comment can still be deleted before the send…
    await review.deleteFirstComment();
    await expect
      .poll(async () => (await review.storedComments(SESSION_ID)).length)
      .toBe(3);

    // …and apply sends the remaining three.
    await review.apply();
    await expect(review.paneLocator()).toBeHidden();
    const after = await review.storedComments(SESSION_ID);
    expect(after.every((c) => c.status === "applied")).toBe(true);
  });
});

// ----- hunk expansion (ADR 0002) -----
// A modified file whose hunk starts at line 5, leaving lines 1–4 as an
// expandable region above it. The seeded full contents match the hunk's
// context/addition lines, so hydration passes stale-content validation.
const expandableFile: FileDiff = {
  old_path: "notes.txt",
  new_path: "notes.txt",
  status: "modified",
  added: 2,
  removed: 1,
  binary: null,
  hunks: [
    {
      old_start: 5,
      old_lines: 3,
      new_start: 5,
      new_lines: 4,
      header: "",
      lines: [
        { origin: "context", old_lineno: 5, new_lineno: 5, content: "alpha" },
        { origin: "deletion", old_lineno: 6, new_lineno: null, content: "beta old" },
        { origin: "addition", old_lineno: null, new_lineno: 6, content: "beta new" },
        { origin: "addition", old_lineno: null, new_lineno: 7, content: "gamma" },
        { origin: "context", old_lineno: 7, new_lineno: 8, content: "delta" },
      ],
    },
  ],
};
const OLD_CONTENTS = "one\ntwo\nthree\nfour\nalpha\nbeta old\ndelta\n";
const NEW_CONTENTS = "one\ntwo\nthree\nfour\nalpha\nbeta new\ngamma\ndelta\n";

test.describe("hunk expansion", () => {
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: { [SESSION_ID]: makeReview({ diff: { files: [expandableFile] } }) },
      reviewFiles: { [SESSION_ID]: { "notes.txt": { old: OLD_CONTENTS, new: NEW_CONTENTS } } },
    },
  });

  test("arrows appear once the file hydrates", async ({ review }) => {
    // Pierre calls the loader eagerly on first render; once both sides load
    // and validation passes, the separator grows expansion arrows.
    await expect(review.expandButtons().first()).toBeVisible();
    // The hunk itself still renders as before.
    await expect(review.line("beta new")).toBeVisible();
  });

  test("expanding reveals the unchanged context above the hunk", async ({ review }) => {
    await review.expandFirst();
    // The whole 4-line gap fits in one default-sized expansion.
    await expect(review.expandedLines()).toHaveCount(4);
    await expect(review.expandedLine("two")).toBeVisible();
  });

  test("expanded rows are read-only: clicking one opens no composer", async ({ review }) => {
    await review.expandFirst();
    await review.expandedLine("two").click();
    await expect(review.diffTextarea()).toHaveCount(0);

    // A hunk line still opens the composer, so the pane stayed interactive.
    await review.selectLine("beta new");
    await expect(review.diffTextarea()).toBeVisible();
  });
});

test.describe("hunk expansion with a drifted working tree", () => {
  // The live new side no longer matches the snapshot's hunk (line 6 changed
  // after open), so stale-content validation fails the loader.
  const drifted = "one\ntwo\nthree\nfour\nalpha\nbeta CHANGED\ngamma\ndelta\n";
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: { [SESSION_ID]: makeReview({ diff: { files: [expandableFile] } }) },
      reviewFiles: { [SESSION_ID]: { "notes.txt": { old: OLD_CONTENTS, new: drifted } } },
    },
  });

  test("yields no arrows — the file stays unexpandable until refresh", async ({ review }) => {
    // Wait until the loader actually read the new side, so "no arrows" means
    // validation rejected hydration rather than hydration not having run yet.
    await expect
      .poll(async () => (await review.storedFileReads()).length)
      .toBeGreaterThan(0);
    await expect(review.expandButtons()).toHaveCount(0);
    // The snapshot's own hunk still renders and stays commentable.
    await review.selectLine("beta new");
    await expect(review.diffTextarea()).toBeVisible();
  });
});

test.describe("with two files", () => {
  const emptyFile = (name: string): FileDiff => ({
    old_path: name,
    new_path: name,
    status: "modified",
    added: 1,
    removed: 0,
    hunks: [],
    binary: null,
  });
  test.use({
    seed: {
      ...defaultSeed(),
      reviews: {
        [SESSION_ID]: makeReview({
          diff: { files: [emptyFile("alpha.txt"), emptyFile("zeta.txt")] },
        }),
      },
    },
  });

  test("Ctrl-N/P and arrows move between files", async ({ review }) => {
    // refresh() selects the first file by default.
    await expect.poll(() => review.activeFileName()).toBe("alpha.txt");

    await review.pressFileNav("ArrowDown");
    await expect.poll(() => review.activeFileName()).toBe("zeta.txt");

    await review.pressFileNav("Control+p");
    await expect.poll(() => review.activeFileName()).toBe("alpha.txt");

    await review.pressFileNav("Control+n");
    await expect.poll(() => review.activeFileName()).toBe("zeta.txt");

    await review.pressFileNav("ArrowUp");
    await expect.poll(() => review.activeFileName()).toBe("alpha.txt");
  });
});
