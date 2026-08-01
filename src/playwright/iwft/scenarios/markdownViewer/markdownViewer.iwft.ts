import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// The markdown viewer (src/markdownViewer.ts): Cmd+M opens a reader over the
// active session's repo docs; the file bar drops a fuzzy picker; in-repo .md
// links open in the viewer.

test.use({
  seed: {
    ...defaultSeed(),
    markdownFiles: {
      "README.md": "# Acme\n\nSee [the plan](plans/plan.md).\n",
      "plans/plan.md": "# The Plan\n\n## Phase 1\n\n- do a thing\n\n## Phase 2\n\n- ship it\n",
      "docs/notes.md": "# Notes\n",
    },
  },
});

test("Cmd+M opens the reader on README; relative links navigate; Esc closes", async ({
  fileExplorer, // reused only for its attached-session boot state
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");

  const root = page.locator("#mdv");
  await expect(root).toBeVisible();
  await expect(root.locator(".mdv-name-text")).toHaveText("README.md");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  await root.locator('.mdv-doc a:has-text("the plan")').click();
  await expect(root.locator(".mdv-doc h1")).toHaveText("The Plan");
  await expect(root.locator(".mdv-name-text")).toHaveText("plans/plan.md");

  await page.keyboard.press("Escape");
  await expect(root).toBeHidden();
});

test("/ opens the fuzzy picker; typing filters; Enter opens the selection", async ({
  fileExplorer,
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  await page.keyboard.press("/");
  await expect(root.locator(".mdv-picker")).toBeVisible();
  await expect(root.locator(".mdv-row")).toHaveCount(3);

  await page.keyboard.type("plan");
  await expect(root.locator(".mdv-row")).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect(root.locator(".mdv-picker")).toBeHidden();
  await expect(root.locator(".mdv-doc h1")).toHaveText("The Plan");

  // Esc with a doc showing closes the picker first, then the viewer.
  await page.keyboard.press("/");
  await page.keyboard.press("Escape");
  await expect(root.locator(".mdv-picker")).toBeHidden();
  await expect(root).toBeVisible();
});

test("clicking the file bar also opens the picker", async ({ fileExplorer }) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  await root.locator(".mdv-name").click();
  await expect(root.locator(".mdv-picker")).toBeVisible();
  await root.locator(".mdv-row", { hasText: "docs/notes.md" }).click();
  await expect(root.locator(".mdv-doc h1")).toHaveText("Notes");
});
