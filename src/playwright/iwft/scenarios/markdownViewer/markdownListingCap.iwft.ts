import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// The markdown listing is newest-first and capped at 500 after sorting; when
// the cap bites, the picker shows a non-selectable truncation row (issue #99).

// 501 seeded docs: doc-000 (mtime 0, stalest) … doc-500 (mtime 500, newest).
// The cap drops exactly one file — the stalest.
const manyFiles: Record<string, { content: string; mtime: number }> = {};
for (let i = 0; i <= 500; i++) {
  const n = String(i).padStart(3, "0");
  manyFiles[`docs/doc-${n}.md`] = { content: `# Doc ${n}\n`, mtime: i };
}

test.use({ seed: { ...defaultSeed(), markdownFiles: manyFiles } });

test("picker lists newest-first and shows the truncation row past the cap", async ({
  fileExplorer, // reused only for its attached-session boot state
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  // No README in the seed, so the viewer leads with the picker.
  await expect(root.locator(".mdv-picker")).toBeVisible();

  // Newest (highest mtime) first.
  await expect(root.locator(".mdv-row").first()).toHaveText("docs/doc-500.md");

  // 501 files, capped at 500 → the truncation row says so and is inert.
  const cap = root.locator(".mdv-cap-row");
  await expect(cap).toHaveText("500 of 501 — keep typing to narrow");
  await cap.click();
  await expect(root.locator(".mdv-picker")).toBeVisible(); // still the picker

  // The stalest file fell past the cap; the next-stalest is still there.
  const input = root.locator(".mdv-input");
  await input.fill("doc-001");
  await expect(root.locator(".mdv-row")).toHaveText(["docs/doc-001.md"]);
  await input.fill("doc-000");
  await expect(root.locator(".mdv-row")).toHaveCount(0);
});
