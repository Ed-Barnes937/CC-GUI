import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed, makeSession, makeSnapshot, makeReview, SESSION_ID } from "../../network/seed.testHelper";

// The Refined detail pane: actions pinned at the top, then meta rows, then a
// "Changes · N files" micro-label over a colorized, proportional diffstat.

test.use({
  seed: {
    ...defaultSeed(),
    diffStats: { [SESSION_ID]: "3 files changed, 124 insertions(+), 38 deletions(-)" },
  },
});

test("pins Review diff / Open PR at the top of the pane", async ({ detail }) => {
  await detail.open("fix login bug");

  // The action bar sits directly under the pane's header — not in a footer.
  await expect(detail.reviewButton()).toBeVisible();
  await expect(detail.prButton()).toBeVisible();
  expect(await detail.precedingElementOfActionBar()).toBe("HEADER");
  // No PR on the seeded session → Open PR is disabled.
  await expect(detail.prButton()).toBeDisabled();
});

test("renders the Changes micro-label with parsed, colorized counts", async ({ detail }) => {
  await detail.open("fix login bug");

  await expect(detail.changesLabel()).toHaveText("Changes · 3 files");
  await expect(detail.addedCount()).toHaveText("+124");
  await expect(detail.removedCount()).toHaveText("−38");
  await expect(detail.proportionalBar()).toBeVisible();
  await expect(detail.metaValue("Branch")).resolves.toBe("fix/login");
});

test("Review diff in the pinned bar opens the review pane", async ({ detail, page }) => {
  await detail.open("fix login bug");
  await detail.reviewButton().click();

  await expect(page.locator("#review")).toBeVisible();
});

test("Escape dismisses the pane", async ({ detail, page }) => {
  await detail.open("fix login bug");
  await expect(page.locator("#detail")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#detail")).toBeHidden();
});

test.describe("session without changes", () => {
  test.use({ seed: defaultSeed() }); // no diffStats seeded

  test("shows a bare Changes label and No changes", async ({ detail }) => {
    await detail.open("fix login bug");

    await expect(detail.changesLabel()).toHaveText("Changes");
    await expect(detail.diffstat()).toHaveText("No changes");
    await expect(detail.proportionalBar()).toHaveCount(0);
  });
});

test.describe("session with a PR", () => {
  test.use({
    seed: {
      ...defaultSeed(),
      snapshot: makeSnapshot({
        groups: [
          {
            id: "proj-1",
            name: "acme",
            repo_path: "/repos/acme",
            pull_blocked: null,
            sessions: [
              makeSession({
                pr_number: 482,
                pr_url: "https://github.com/acme/acme/pull/482",
                pr_state: "open",
              }),
            ],
          },
        ],
      }),
      reviews: { [SESSION_ID]: makeReview() },
    },
  });

  test("Open PR is enabled and launches the PR url externally", async ({ detail }) => {
    await detail.open("fix login bug");

    await expect(detail.prButton()).toBeEnabled();
    await detail.prButton().click();
    await expect(async () => {
      expect(await detail.openedUrls()).toContain("https://github.com/acme/acme/pull/482");
    }).toPass();
  });
});
