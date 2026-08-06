import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// Session-aware ⌘M (issue #101, ADR-0007): the viewer opens the doc that
// matters now — docs the session's branch changed (newest first) → README →
// straight into the picker — with the last-viewed doc winning unless the agent
// has touched something since. The picker's default order is the same
// relevance ranking. mtimes are real epoch seconds because the last-viewed rule
// compares a doc's mtime against the wall-clock time of the last view.

const NOW = Math.floor(Date.now() / 1000);

test.describe("branch-changed docs win", () => {
  test.use({
    seed: {
      ...defaultSeed(),
      markdownFiles: {
        // A README touched more recently than either plan — mtime alone would
        // pick it; the branch flag is what makes the ladder useful.
        "README.md": { content: "# Acme\n", mtime: NOW - 5 },
        "plans/stale-plan.md": {
          content: "# Stale Plan\n",
          mtime: NOW - 600,
          changedOnBranch: true,
        },
        "plans/fresh-plan.md": {
          content: "# Fresh Plan\n",
          mtime: NOW - 120,
          changedOnBranch: true,
        },
        "docs/notes.md": { content: "# Notes\n", mtime: NOW - 10 },
      },
    },
  });

  test("⌘M opens the newest doc the session's branch changed", async ({ fileExplorer }) => {
    const page = fileExplorer.paneLocator().page();
    await page.keyboard.press("Meta+m");

    const root = page.locator("#mdv");
    await expect(root.locator(".mdv-name-text")).toHaveText("plans/fresh-plan.md");
    await expect(root.locator(".mdv-doc h1")).toHaveText("Fresh Plan");
  });

  test("the picker's default order is relevance, and typing keeps it as the tiebreak", async ({
    fileExplorer,
  }) => {
    const page = fileExplorer.paneLocator().page();
    await page.keyboard.press("Meta+m");
    const root = page.locator("#mdv");
    await expect(root.locator(".mdv-doc h1")).toHaveText("Fresh Plan");

    await page.keyboard.press("/");
    await expect(root.locator(".mdv-row")).toHaveText([
      "plans/fresh-plan.md",
      "plans/stale-plan.md",
      "README.md",
      "docs/notes.md",
    ]);

    // Filtering to the two plans keeps relevance as the tiebreak: the one the
    // agent touched last is still the top row.
    await page.keyboard.type("plan");
    await expect(root.locator(".mdv-row")).toHaveText([
      "plans/fresh-plan.md",
      "plans/stale-plan.md",
    ]);
  });

  test("reopening returns to the last-viewed doc, unless a changed doc is newer", async ({
    fileExplorer,
  }) => {
    const page = fileExplorer.paneLocator().page();
    await page.keyboard.press("Meta+m");
    const root = page.locator("#mdv");
    await expect(root.locator(".mdv-doc h1")).toHaveText("Fresh Plan");

    // Read something else, then close: that's where the reader left off.
    await page.keyboard.press("/");
    await root.locator(".mdv-row", { hasText: "docs/notes.md" }).click();
    await expect(root.locator(".mdv-name-text")).toHaveText("docs/notes.md");
    await page.keyboard.press("Escape");
    await expect(root).toBeHidden();

    await page.keyboard.press("Meta+m");
    await expect(root.locator(".mdv-name-text")).toHaveText("docs/notes.md");
    await page.keyboard.press("Escape");

    // The agent writes a plan after that view — now the ladder wins.
    await page.evaluate(
      (mtime) =>
        window.__CC_SIM__.setMarkdownFile("plans/fresh-plan.md", "# Fresh Plan v2\n", {
          mtime,
          changedOnBranch: true,
        }),
      NOW + 300,
    );
    await page.keyboard.press("Meta+m");
    await expect(root.locator(".mdv-name-text")).toHaveText("plans/fresh-plan.md");
    await expect(root.locator(".mdv-doc h1")).toHaveText("Fresh Plan v2");
  });
});

test.describe("no changed docs, no README", () => {
  test.use({
    seed: {
      ...defaultSeed(),
      markdownFiles: {
        "docs/notes.md": { content: "# Notes\n", mtime: NOW - 10 },
        "docs/other.md": { content: "# Other\n", mtime: NOW - 500 },
      },
    },
  });

  test("⌘M lands in the picker rather than an empty pane", async ({ fileExplorer }) => {
    const page = fileExplorer.paneLocator().page();
    await page.keyboard.press("Meta+m");
    const root = page.locator("#mdv");

    await expect(root.locator(".mdv-picker")).toBeVisible();
    await expect(root.locator(".mdv-name-text")).toHaveText("choose a file…");
    await expect(root.locator(".mdv-row")).toHaveText(["docs/notes.md", "docs/other.md"]);
  });
});
