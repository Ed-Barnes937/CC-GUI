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
