import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// Live reload (issue #100, ADR-0004): while the viewer is open, the displayed
// file is re-read on a ~1.5s poll and re-renders in place when its content
// changed — scroll preserved, no re-render when unchanged, a failed read keeps
// the last good rendering, and polling stops when the viewer closes or the
// window hides. The poll interval is driven with Playwright's fake clock
// (installed after boot, so only the viewer's interval is faked): a runFor
// past the interval fires exactly the polls it covers, no wall-clock sleeps.

// Mirrors POLL_MS in src/markdownViewer.ts (not imported: that module builds
// its DOM at import time, and this file runs in Node).
const POLL = 1500;

const LONG_DOC =
  "# Acme\n\n" +
  Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\nparagraph ${i + 1}\n`).join("\n");

test.use({
  seed: {
    ...defaultSeed(),
    markdownFiles: {
      "README.md": LONG_DOC,
      "docs/notes.md": "# Notes\n",
    },
  },
});

test("a content change on disk re-renders in place; scroll preserved; unchanged content untouched", async ({
  fileExplorer,
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.clock.install();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  // Tag the rendered DOM, then let two polls of unchanged content fire: the
  // tag surviving proves the doc was not re-rendered.
  await page.evaluate(() =>
    document.querySelector("#mdv .mdv-doc h1")!.setAttribute("data-live-marker", "1"),
  );
  await page.clock.runFor(2 * POLL + 100);
  await expect(root.locator(".mdv-doc h1[data-live-marker]")).toBeVisible();

  // Scroll into the middle of the doc, then append to the file: the new
  // section appears on the next poll and the scroll position holds.
  await page.evaluate(() => {
    document.querySelector("#mdv .mdv-doc")!.scrollTop = 400;
  });
  await page.evaluate(
    (doc) => window.__CC_SIM__.setMarkdownFile("README.md", doc),
    LONG_DOC + "\n## Fresh Section\n\nagent just wrote this\n",
  );
  await page.clock.runFor(POLL + 100);
  await expect(root.locator(".mdv-doc h2", { hasText: "Fresh Section" })).toBeAttached();
  // Re-rendered: the marker is gone…
  await expect(root.locator(".mdv-doc h1[data-live-marker]")).toHaveCount(0);
  // …and the reader did not jump.
  expect(await page.evaluate(() => document.querySelector("#mdv .mdv-doc")!.scrollTop)).toBe(400);
});

test("a failed poll read keeps the last good rendering, then recovers", async ({
  fileExplorer,
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.clock.install();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  await page.evaluate(() => window.__CC_SIM__.setMarkdownReadsFail(true));
  await page.clock.runFor(2 * POLL + 100);
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");
  await expect(page.locator(".toast.error")).toHaveCount(0);

  // Reads working again → the next poll picks up the newer content.
  await page.evaluate(() => {
    window.__CC_SIM__.setMarkdownReadsFail(false);
    window.__CC_SIM__.setMarkdownFile("README.md", "# Acme v2\n");
  });
  await page.clock.runFor(POLL + 100);
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme v2");
});

test("polling stops when the viewer closes and while the window is hidden", async ({
  fileExplorer,
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.clock.install();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  // Hidden window: the poll pauses…
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCount = await page.evaluate(() => window.__CC_SIM__.getMarkdownReadCount());
  await page.clock.runFor(4 * POLL);
  expect(await page.evaluate(() => window.__CC_SIM__.getMarkdownReadCount())).toBe(hiddenCount);

  // …and resumes when the window is visible again.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(POLL + 100);
  expect(await page.evaluate(() => window.__CC_SIM__.getMarkdownReadCount())).toBeGreaterThan(
    hiddenCount,
  );

  // Closed viewer: no further reads at all.
  await page.keyboard.press("Escape");
  await expect(root).toBeHidden();
  const closedCount = await page.evaluate(() => window.__CC_SIM__.getMarkdownReadCount());
  await page.clock.runFor(4 * POLL);
  expect(await page.evaluate(() => window.__CC_SIM__.getMarkdownReadCount())).toBe(closedCount);
});

test("the picker re-lists on open so files created since surface", async ({ fileExplorer }) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const root = page.locator("#mdv");
  await expect(root.locator(".mdv-doc h1")).toHaveText("Acme");

  await page.evaluate(() => window.__CC_SIM__.setMarkdownFile("plans/brand-new.md", "# New\n"));
  await page.keyboard.press("/");
  await expect(root.locator(".mdv-row", { hasText: "plans/brand-new.md" })).toBeVisible();
});
