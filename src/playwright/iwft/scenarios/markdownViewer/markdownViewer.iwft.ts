import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// PROTOTYPE: smoke test for the markdown-viewer prototype
// (src/markdownViewerPrototype.ts) — delete with it. Verifies each of the
// three variants renders real markdown and the switcher cycles them.

test.use({
  seed: {
    ...defaultSeed(),
    markdownFiles: {
      "README.md": "# Acme\n\nSee [the plan](plans/plan.md).\n",
      "plans/plan.md": "# The Plan\n\n## Phase 1\n\n- do a thing\n\n## Phase 2\n\n- ship it\n",
    },
  },
});

test("Cmd+M opens variant A (docs site) with the file list and rendered doc", async ({
  fileExplorer, // reused only for its attached-session boot state
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");

  const root = page.locator("#mdv-root");
  await expect(root).toBeVisible();
  await expect(root).toHaveAttribute("data-variant", "A");
  await expect(root.locator(".mdv-a-file")).toHaveCount(2);
  // README is the default file; its heading renders as real HTML.
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  // Relative .md links open in the viewer.
  await root.locator('.mdv-doc a:has-text("the plan")').click();
  await expect(root.locator(".mdv-doc h1")).toHaveText("The Plan");
});

test("arrow keys cycle variants B (reader) and C (side rail with outline)", async ({
  fileExplorer,
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv-root");
  await expect(root).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(root).toHaveAttribute("data-variant", "B");
  await expect(root.locator(".mdv-b-doc h1")).toHaveText("Acme");

  await page.keyboard.press("ArrowRight");
  await expect(root).toHaveAttribute("data-variant", "C");
  await expect(root.locator(".mdv-c-doc h1")).toHaveText("Acme");

  // Outline lists the doc's headings; Escape closes the viewer.
  await root.locator(".mdv-c-select").selectOption("plans/plan.md");
  await expect(root.locator(".mdv-c-h")).toHaveCount(3); // h1 + two h2
  await page.keyboard.press("Escape");
  await expect(root).toBeHidden();
});
