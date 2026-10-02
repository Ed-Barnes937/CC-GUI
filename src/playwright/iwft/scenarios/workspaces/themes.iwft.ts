import { test, expect } from "../../support/fixture.testHelper";
import { workspacesSeed } from "../../network/seed.testHelper";
import { WorkspaceSettingsPageObject } from "../../../pageObjects/WorkspaceSettingsPageObject.testHelper";
import { ThemePickerPageObject } from "../../../pageObjects/ThemePickerPageObject.testHelper";
import { TerminalPageObject } from "../../../pageObjects/TerminalPageObject.testHelper";
import { MOCHA, THEMES } from "../../../../theme/palettes";
import type { Page } from "@playwright/test";

// A theme per workspace (handoff 1f): Settings › Workspaces sets one palette
// per workspace ("Global theme" inherits), and switching re-skins the chrome,
// the terminal and diffs. The theme picker keeps editing the global theme,
// and says so while an override covers it.
//
// workspacesSeed(): Main holds acme ("fix login bug"); Work holds atlas-api
// and web-app; OSS holds dotfiles ("nvim lsp config"). The global theme is
// pinned to dark (Catppuccin Mocha) so the starting palette is fixed.

const TOKYO = THEMES["tokyo-night"];

/** A CSS variable as applied to :root. */
function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

/** #rrggbb as getComputedStyle reports a colour. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test.use({ seed: workspacesSeed(), colorScheme: "dark" });

/** Open Settings › Workspaces from the chip. */
async function openTab(page: Page): Promise<WorkspaceSettingsPageObject> {
  const tab = new WorkspaceSettingsPageObject(page);
  await tab.openFromChip();
  return tab;
}

test("each row has a theme select: Global theme, then every palette", async ({ workspaces, page }) => {
  void workspaces;
  const tab = await openTab(page);
  for (const label of ["Main", "Work", "OSS"]) {
    await expect(tab.themeSelect(label)).toHaveValue("");
    await expect(tab.themeSelect(label).locator("option:checked")).toHaveText("Global theme");
  }
  const options = tab.themeSelect("OSS").locator("option");
  await expect(options).toHaveText(["Global theme", ...Object.values(THEMES).map((t) => t.label)]);
  // It sits before ✎ in the row, at the handoff's 150px.
  const order = await tab
    .row("OSS")
    .evaluate((row) => [...row.children].map((c) => c.className.split(" ").pop()));
  expect(order.indexOf("ws-theme")).toBe(order.indexOf("ws-rename-btn") - 1);
  expect((await tab.themeSelect("OSS").boundingBox())?.width).toBe(150);
});

test("switching to a workspace with a theme applies it, and switching away reverts", async ({ workspaces, page }) => {
  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  expect(await tab.storedThemes()).toEqual({ OSS: "tokyo-night" });
  // Main is on screen, so nothing changed yet.
  expect(await cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
  await tab.close();

  await workspaces.switchTo("OSS");
  await expect.poll(() => cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);
  expect(await cssVar(page, "--bg-base")).toBe(TOKYO.cssVars["bg-base"]);

  // The terminal follows too.
  const terminal = new TerminalPageObject(page);
  await terminal.attach("nvim lsp config");
  const viewport = page.locator("#terminals .term-container.active .xterm-viewport");
  await expect(viewport).toHaveCSS("background-color", rgb(TOKYO.terminal.background!));

  await workspaces.switchTo("Main");
  await expect.poll(() => cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
  await workspaces.switchTo("OSS");
  await expect.poll(() => cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);
  await expect(viewport).toHaveCSS("background-color", rgb(TOKYO.terminal.background!));
});

test("setting the active workspace's theme applies at once; Global theme reverts", async ({ workspaces, page }) => {
  await workspaces.switchTo("OSS");
  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  await expect.poll(() => cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);
  await tab.setTheme("OSS", "Global theme");
  await expect.poll(() => cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
  expect(await tab.storedThemes()).toEqual({});
});

test("Main can have its own theme too", async ({ workspaces, page }) => {
  void workspaces;
  const tab = await openTab(page);
  await tab.setTheme("Main", "Nord");
  await expect.poll(() => cssVar(page, "--accent")).toBe(THEMES.nord.cssVars.accent);
  expect(await tab.storedThemes()).toEqual({ "\u0000main": "nord" });
});

test("the theme follows a rename and goes with a delete", async ({ workspaces, page }) => {
  await workspaces.switchTo("OSS");
  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  await tab.rename("OSS", "Open source");
  await expect(tab.themeSelect("Open source")).toHaveValue("tokyo-night");
  expect(await tab.storedThemes()).toEqual({ "Open source": "tokyo-night" });
  await expect(workspaces.chipLabel()).toHaveText("Open source");
  expect(await cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);

  await tab.startDelete("Open source");
  await tab.confirmDelete();
  await expect(tab.names()).toHaveText(["Main", "Work"]);
  expect(await tab.storedThemes()).toEqual({});
  await expect.poll(() => cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
});

test("a workspace deleted from the TUI drops its theme and reverts the screen", async ({ workspaces, page }) => {
  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  await tab.close();
  await workspaces.switchTo("OSS");
  await expect.poll(() => cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);

  await workspaces.fromTui("delete_workspace", { name: "OSS" });
  await expect(workspaces.chipLabel()).toHaveText("Main");
  await expect.poll(() => cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
  expect(await tab.storedThemes()).toEqual({});
});

test("the theme picker notes the override and its Manage opens the tab", async ({ workspaces, page }) => {
  const picker = new ThemePickerPageObject(page);
  // No override on screen: no note.
  await picker.openFromTitlebar();
  await expect(picker.overrideNote()).toHaveCount(0);
  await picker.cancelEsc();

  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  await tab.close();
  await workspaces.switchTo("OSS");

  await picker.openFromTitlebar();
  await expect(picker.overrideNote()).toHaveText("OSS uses Tokyo Night · Manage");
  // The ✓ is on the global theme, which is what the picker edits.
  expect(await picker.currentLabel()).toBe("Catppuccin Mocha");

  await picker.manage();
  await expect(tab.heading()).toHaveText("Workspaces");
  await expect(tab.themeSelect("OSS")).toHaveValue("tokyo-night");
  expect(await cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);
});

test("choosing a global theme under an override keeps the override, and Main gets the choice", async ({ workspaces, page }) => {
  const tab = await openTab(page);
  await tab.setTheme("OSS", "Tokyo Night");
  await tab.close();
  await workspaces.switchTo("OSS");

  const picker = new ThemePickerPageObject(page);
  await picker.open("dark");
  await picker.clickRow("Nord");
  await expect.poll(() => cssVar(page, "--accent")).toBe(TOKYO.cssVars.accent);
  expect(await picker.storedThemeId("dark")).toBe("nord");

  await workspaces.switchTo("Main");
  await expect.poll(() => cssVar(page, "--accent")).toBe(THEMES.nord.cssVars.accent);
});

test.describe("relaunching", () => {
  test("into the same workspace paints its theme before the app boots", async ({ workspaces, page }) => {
    const tab = await openTab(page);
    // A light palette under a dark global theme: the boot must take the
    // override's appearance, not the mode's.
    await tab.setTheme("OSS", "GitHub Light");
    await tab.close();
    await workspaces.switchTo("OSS");
    await expect.poll(() => cssVar(page, "--accent")).toBe(THEMES["github-light"].cssVars.accent);

    // Only the no-flash boot script runs: the app's module never loads.
    await page.route(/\/src\/main\.ts/, (route) => route.abort());
    await page.reload();
    await expect(page.locator("#sessions .group-by-bar")).toHaveCount(0); // never booted
    expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe("light");
    expect(await cssVar(page, "--accent")).toBe(THEMES["github-light"].cssVars.accent);
  });

  test("into a workspace without one paints the global theme", async ({ workspaces, page }) => {
    const tab = await openTab(page);
    await tab.setTheme("OSS", "GitHub Light");
    await tab.close();
    await workspaces.switchTo("OSS");
    await workspaces.switchTo("Main");

    await page.route(/\/src\/main\.ts/, (route) => route.abort());
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe("dark");
    expect(await cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);
  });
});

test.describe("a custom theme as a workspace's", () => {
  test.use({
    seed: {
      ...workspacesSeed(),
      customThemes: [
        {
          file: "team-dark.json",
          content: { id: "team-dark", label: "Team Dark", appearance: "dark", cssVars: { accent: "#ff00aa" } },
        },
      ],
    },
  });

  test("is offered, applies, and falls back to the global theme when its file goes", async ({ workspaces, page }) => {
    const tab = await openTab(page);
    await expect(tab.themeSelect("OSS").locator("option").last()).toHaveText("Team Dark");
    await tab.setTheme("OSS", "Team Dark");
    await tab.close();
    await workspaces.switchTo("OSS");
    await expect.poll(() => cssVar(page, "--accent")).toBe("#ff00aa");

    // The file is deleted and the themes reloaded.
    await page.evaluate(() => window.__CC_SIM__.setCustomThemes([]));
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator("#palette input").fill("Reload custom themes");
    await page.locator("#palette input").press("Enter");
    await expect.poll(() => cssVar(page, "--accent")).toBe(MOCHA.cssVars.accent);

    // The choice is kept, and shows as missing, so it comes back with the file.
    await openTab(page);
    await expect(tab.themeSelect("OSS").locator("option:checked")).toHaveText("team-dark (not found)");
    expect(await tab.storedThemes()).toEqual({ OSS: "team-dark" });
  });
});
