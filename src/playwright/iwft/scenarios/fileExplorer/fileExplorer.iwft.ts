import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed } from "../../network/seed.testHelper";

// Default seed's session attaches under this tmux name (see makeSession).
const TMUX = "cc-sess-1";

test.use({
  seed: {
    ...defaultSeed(),
    fileTree: {
      "": [
        { name: "src", is_dir: true, size: 0 },
        { name: "README.md", is_dir: false, size: 1200 },
        { name: ".hidden", is_dir: false, size: 10 },
      ],
      src: [
        { name: "theme", is_dir: true, size: 0 },
        { name: "main.ts", is_dir: false, size: 5000 },
        { name: "review.ts", is_dir: false, size: 3000 },
      ],
      "src/theme": [{ name: "palettes.ts", is_dir: false, size: 900 }],
    },
  },
});

test("Cmd+E opens the explorer rooted at the repo; hidden files are off by default", async ({
  fileExplorer,
}) => {
  await fileExplorer.open();

  await expect(fileExplorer.rows()).toHaveCount(2); // .hidden excluded
  await expect(fileExplorer.row("src")).toBeVisible();
  await expect(fileExplorer.row("README.md")).toBeVisible();
  await expect(fileExplorer.row(".hidden")).toHaveCount(0);
  expect(await fileExplorer.crumbsText()).toBe("acme");
});

test("Enter drills into a folder; breadcrumb and contents update", async ({ fileExplorer }) => {
  await fileExplorer.open();

  // Directories sort first, so the cursor starts on src/.
  expect(await fileExplorer.cursorName()).toBe("src/");
  await fileExplorer.press("Enter");

  await expect(fileExplorer.row("main.ts")).toBeVisible();
  await expect(fileExplorer.row("review.ts")).toBeVisible();
  expect(await fileExplorer.crumbsText()).toContain("src");
});

test("opening a file writes an @path reference into the active terminal and closes", async ({
  fileExplorer,
}) => {
  await fileExplorer.open();
  await fileExplorer.press("Enter"); // into src/
  await fileExplorer.press("ArrowDown"); // past theme/, onto the first file
  expect(await fileExplorer.cursorName()).toBe("main.ts");

  await fileExplorer.press("Enter"); // reference the file

  await expect(fileExplorer.paneLocator()).toBeHidden();
  expect(await fileExplorer.ptyWrites()).toContainEqual({
    tmuxSession: TMUX,
    data: "@src/main.ts ",
  });
});

test("Ctrl+. toggles hidden files", async ({ fileExplorer }) => {
  await fileExplorer.open();
  await expect(fileExplorer.row(".hidden")).toHaveCount(0);

  await fileExplorer.press("Control+.");

  await expect(fileExplorer.row(".hidden")).toBeVisible();
});

test("typing fuzzy-searches the whole repo, not just the open folder", async ({ fileExplorer }) => {
  await fileExplorer.open();

  // "plts" is a subsequence of palettes.ts, two folders below the root.
  await fileExplorer.type("plts");

  await expect(fileExplorer.rows()).toHaveCount(1);
  await expect(fileExplorer.row("src/theme/palettes.ts")).toBeVisible();
  expect(await fileExplorer.cursorName()).toBe("palettes.ts");
});

test("a search hit on a file references its full path from the repo root", async ({
  fileExplorer,
}) => {
  await fileExplorer.open();
  await fileExplorer.type("plts");

  await fileExplorer.press("Enter");

  await expect(fileExplorer.paneLocator()).toBeHidden();
  expect(await fileExplorer.ptyWrites()).toContainEqual({
    tmuxSession: TMUX,
    data: "@src/theme/palettes.ts ",
  });
});

test("a search hit on a folder navigates there and clears the search", async ({ fileExplorer }) => {
  await fileExplorer.open();
  await fileExplorer.type("theme");

  await fileExplorer.press("Enter");

  await expect(fileExplorer.row("palettes.ts")).toBeVisible();
  expect(await fileExplorer.crumbsText()).toContain("theme");
  await expect(fileExplorer.searchLocator()).toBeHidden();
});

test("Backspace deletes search characters, then Esc drops back to browsing", async ({
  fileExplorer,
}) => {
  await fileExplorer.open();
  await fileExplorer.type("readme");
  await expect(fileExplorer.rows()).toHaveCount(1);

  // Widening the query by a character brings other paths back.
  await fileExplorer.press("Backspace");
  await expect(fileExplorer.searchLocator()).toHaveText("⌕ readm");

  await fileExplorer.press("Escape");

  await expect(fileExplorer.searchLocator()).toBeHidden();
  await expect(fileExplorer.paneLocator()).toBeVisible(); // Esc cleared, didn't close
  await expect(fileExplorer.row("src")).toBeVisible();
});

test("hidden files stay out of the repo-wide search until toggled on", async ({ fileExplorer }) => {
  await fileExplorer.open();
  await fileExplorer.type("hidden");
  await expect(fileExplorer.row(".hidden")).toHaveCount(0);

  await fileExplorer.press("Control+.");

  await expect(fileExplorer.row(".hidden")).toBeVisible();
});

test("Backspace navigates up to the parent", async ({ fileExplorer }) => {
  await fileExplorer.open();
  await fileExplorer.press("Enter"); // into src/
  await expect(fileExplorer.row("main.ts")).toBeVisible();

  await fileExplorer.press("Backspace");

  await expect(fileExplorer.row("src")).toBeVisible();
  expect(await fileExplorer.crumbsText()).toBe("acme");
});

test("Esc and Cmd+E both close the explorer", async ({ fileExplorer }) => {
  await fileExplorer.open();
  await fileExplorer.press("Escape");
  await expect(fileExplorer.paneLocator()).toBeHidden();

  await fileExplorer.open();
  await fileExplorer.press("Meta+e");
  await expect(fileExplorer.paneLocator()).toBeHidden();
});
