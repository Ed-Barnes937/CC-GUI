import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// Production rendering of the markdown viewer (src/markdownViewer.ts):
// repo-relative images swap to data: URIs via read_session_image (broken or
// non-whitelisted ones become a quiet placeholder, remote https stays
// untouched), and fenced code blocks are Shiki-highlighted (issue #99).

// A 1×1 transparent PNG, base64 — what read_session_image would return.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.use({
  seed: {
    ...defaultSeed(),
    markdownFiles: {
      // README so the viewer opens straight onto the document.
      "README.md": [
        "# Guide",
        "",
        "![diagram](docs/assets/diagram.png)",
        "![gone](docs/assets/missing.png)",
        "![bitmap](docs/assets/legacy.bmp)",
        "![badge](https://example.com/badge.svg)",
        "",
        "```rust",
        "fn main() {}",
        "```",
        "",
      ].join("\n"),
    },
    sessionImages: { "docs/assets/diagram.png": PNG_1PX },
  },
});

test("relative images become data: URIs; broken/non-whitelisted get placeholders; remote untouched", async ({
  fileExplorer, // reused only for its attached-session boot state
}) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const doc = page.locator("#mdv .mdv-doc");
  await expect(doc.locator("h1")).toHaveText("Guide");

  // Seeded relative image → swapped to an inline data: URI.
  await expect(doc.locator('img[alt="diagram"]')).toHaveAttribute(
    "src",
    `data:image/png;base64,${PNG_1PX}`,
  );

  // Missing file and non-whitelisted extension → quiet placeholder, and the
  // rest of the document still rendered.
  await expect(doc.locator(".mdv-img-missing")).toHaveCount(2);
  await expect(doc.locator(".mdv-img-missing").first()).toHaveText("⊘ docs/assets/missing.png");

  // Remote https image is left alone.
  await expect(doc.locator('img[alt="badge"]')).toHaveAttribute(
    "src",
    "https://example.com/badge.svg",
  );
});

test("fenced code blocks are Shiki-highlighted", async ({ fileExplorer }) => {
  const page = fileExplorer.paneLocator().page();
  await page.keyboard.press("Meta+m");
  const doc = page.locator("#mdv .mdv-doc");
  await expect(doc.locator("h1")).toHaveText("Guide");

  // Shiki replaces the plain <pre> with its own themed block of colored spans.
  const shiki = doc.locator("pre.shiki");
  await expect(shiki).toHaveCount(1);
  await expect(shiki).toContainText("fn main() {}");
  expect(await shiki.locator("code span[style*='color']").count()).toBeGreaterThan(0);
});
