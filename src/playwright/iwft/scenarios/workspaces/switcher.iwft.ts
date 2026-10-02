import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed, workspacesSeed } from "../../network/seed.testHelper";
import type { Seed } from "../../network/types.testHelper";
import { SidebarPageObject } from "../../../pageObjects/SidebarPageObject.testHelper";
import { TerminalPageObject } from "../../../pageObjects/TerminalPageObject.testHelper";
import { BoardPageObject } from "../../../pageObjects/BoardPageObject.testHelper";
import { PalettePageObject } from "../../../pageObjects/PalettePageObject.testHelper";

// The title-bar workspace switcher (handoff 1a and its menu): switching is a
// hard filter over every surface, each workspace keeps its own cursor and tab,
// and hidden workspaces' terminals stay attached.
//
// workspacesSeed(): Main holds acme ("fix login bug"); Work holds atlas-api
// ("rate limiter", "auth token refresh") and web-app ("billing page"); OSS
// holds dotfiles ("nvim lsp config").

/** workspacesSeed with overrides on the seed and its workspace config. */
function seedWith(over: Partial<Seed> = {}, config: Seed["workspaces"] = {}): Seed {
  const seed = workspacesSeed();
  return { ...seed, ...over, workspaces: { ...seed.workspaces, ...config } };
}

test.describe("with only Main", () => {
  test.use({ seed: { ...defaultSeed(), keybindings: { workspace_picker: ["W"] } } });

  test("the chip stays hidden, leaving the title bar as it was", async ({ workspaces }) => {
    await expect(workspaces.countPill()).toHaveText("1 sessions · 1 live");
    await expect(workspaces.chip()).toBeHidden();
  });

  test("the picker key still opens the menu, to create the first workspace", async ({ workspaces, page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Shift+W");
    await expect(workspaces.menu()).toBeVisible();
    await expect(workspaces.menuRows()).toHaveCount(1);
  });
});

test.describe("with three workspaces", () => {
  test.use({ seed: workspacesSeed() });

  test("the chip names the active workspace and its menu lists them all", async ({ workspaces }) => {
    await expect(workspaces.chip()).toBeVisible();
    await expect(workspaces.chipLabel()).toHaveText("Main");
    await workspaces.openMenu();
    await expect(workspaces.menu().locator(".menu-header")).toHaveText("Workspaces");
    await expect(workspaces.menuRows().locator(".menu-label")).toHaveText(["Main", "Work", "OSS"]);
    await expect(workspaces.menuRows().locator(".menu-meta")).toHaveText(["1 project", "2 projects", "1 project"]);
    await expect(workspaces.menuRows().locator(".menu-shortcut")).toHaveText(["⌘⌥1", "⌘⌥2", "⌘⌥3"]);
    await expect(workspaces.tickedRow().locator(".menu-label")).toHaveText("Main");
    await expect(workspaces.menu().locator(".menu-item.indent")).toHaveText([
      "New workspace…",
      "Manage workspaces…",
    ]);
    await expect(workspaces.chip()).toHaveClass(/open/);
  });

  test("switching filters the sidebar and the counts", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await expect(sidebar.titles()).toHaveText(["fix login bug"]);
    await workspaces.switchTo("Work");
    await expect(sidebar.titles()).toHaveText(["rate limiter", "auth token refresh", "billing page"]);
    await expect(workspaces.countPill()).toHaveText("3 sessions · 3 live");
    await expect(page.locator("#sessions .project-header")).toHaveText([/atlas-api/, /web-app/]);
    expect(await workspaces.persistedActive()).toBe("Work");
  });

  test("Cmd+Opt+N jumps to the Nth workspace", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.switchByNumber(3);
    await expect(workspaces.chipLabel()).toHaveText("OSS");
    await expect(sidebar.titles()).toHaveText(["nvim lsp config"]);
    await workspaces.switchByNumber(9); // no ninth workspace: nothing happens
    await expect(workspaces.chipLabel()).toHaveText("OSS");
    await workspaces.switchByNumber(1);
    await expect(workspaces.chipLabel()).toHaveText("Main");
  });

  test("Cmd+Shift+N doesn't switch: macOS keeps Cmd+Shift+3/4/5 for screenshots", async ({
    workspaces,
    page,
  }) => {
    await page.keyboard.press("Meta+Shift+Digit2");
    await page.keyboard.press("Meta+Shift+Digit3");
    await expect(workspaces.chipLabel()).toHaveText("Main");
    expect(await workspaces.persistedActive()).toBe(null);
  });

  test("Cmd+Opt+N leaves Cmd+N and Cmd+Opt+arrows to the tabs and sessions", async ({ workspaces, page }) => {
    // Pressed with the terminal focused, as a user would: the capture-phase
    // accelerators run before xterm sees the key.
    const terminal = new TerminalPageObject(page);
    const activeTab = page.locator("#tabs .tab.active .tab-label");
    await workspaces.switchByNumber(2);
    await expect(workspaces.chipLabel()).toHaveText("Work");
    for (const title of ["rate limiter", "auth token refresh"]) {
      await page.locator(".session-row .title", { hasText: title }).click();
      await expect(activeTab).toHaveText(title);
    }
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveText(["rate limiter", "auth token refresh"]);

    await page.keyboard.press("Meta+1");
    await expect(activeTab).toHaveText("rate limiter");
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await expect(activeTab).toHaveText("auth token refresh");
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await expect(activeTab).toHaveText("rate limiter");
    // The sidebar cursor is still on the last row clicked.
    await page.keyboard.press("Meta+Alt+ArrowDown");
    await expect(activeTab).toHaveText("billing page");
    await page.keyboard.press("Meta+Alt+ArrowUp");
    await expect(activeTab).toHaveText("auth token refresh");
    await expect(workspaces.chipLabel()).toHaveText("Work");

    await workspaces.switchByNumber(1);
    await expect(workspaces.chipLabel()).toHaveText("Main");
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveCount(0);
  });

  test("the palette lists the other workspaces and only this workspace's sessions", async ({
    workspaces,
    page,
  }) => {
    const palette = new PalettePageObject(page);
    await palette.open();
    await palette.type("Switch workspace");
    await expect(palette.labels()).toHaveText("Switch workspace: Work");
    expect(await palette.rowTexts()).toEqual(["Switch workspace: Work", "Switch workspace: OSS"]);
    await palette.clickRow("Switch workspace: OSS");
    await expect(workspaces.chipLabel()).toHaveText("OSS");

    await palette.open();
    await palette.type("billing");
    expect(await palette.rowTexts()).toEqual([]); // a Work session, hidden from OSS
    await palette.type("nvim");
    await expect(palette.labels()).toHaveText("nvim lsp config");
  });

  test("terminals of a hidden workspace drop out of the strip but stay attached", async ({
    workspaces,
    page,
  }) => {
    const terminal = new TerminalPageObject(page);
    await terminal.attach("fix login bug");
    await workspaces.switchTo("Work");
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveCount(0);
    expect(await terminal.placeholderVisible()).toBe(true);

    await page.locator(".session-row .title", { hasText: "rate limiter" }).click();
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveText(["rate limiter"]);

    await workspaces.switchTo("Main");
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveText(["fix login bug"]);
    await expect(page.locator("#tabs .tab.active .tab-label")).toHaveText("fix login bug");
    expect((await workspaces.attachedPtys()).sort()).toEqual(["cc-proj-atlas-s1", "cc-sess-1"]);
  });

  test("each workspace comes back to its own cursor and tab", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.switchTo("Work");
    await page.locator(".session-row .title", { hasText: "billing page" }).click();
    await page.locator(".session-row .title", { hasText: "rate limiter" }).click();
    await workspaces.switchTo("OSS");
    await expect(page.locator(".session-row.selected")).toHaveCount(0);
    await workspaces.switchTo("Work");
    await expect(sidebar.row("rate limiter")).toHaveClass(/selected/);
    await expect(page.locator("#tabs .tab.active .tab-label")).toHaveText("rate limiter");
  });

  test("the attention pill counts only this workspace's sessions", async ({ workspaces, page }) => {
    await page.evaluate(async () => {
      const snap = window.__CC_IWFT_SEED__.snapshot;
      snap.groups[1].sessions[0].agent_state = "waitingforinput"; // Work's "rate limiter"
      await window.__CC_SIM__.pushSnapshot(snap);
    });
    await expect(workspaces.attentionPill()).toBeHidden();
    await workspaces.switchTo("Work");
    await expect(workspaces.attentionPill()).toHaveText("1 waiting on you");
  });

  test("the Board shows this workspace's cards, projects and dock", async ({ workspaces, page }) => {
    const terminal = new TerminalPageObject(page);
    const board = new BoardPageObject(page);
    await terminal.attach("fix login bug");
    await board.enter();
    expect(await board.dockName_()).toBe("fix login bug");

    await workspaces.switchTo("Work");
    await expect(board.cardTitles()).toHaveText(["rate limiter", "auth token refresh", "billing page"]);
    expect(await board.dockPlaceholderVisible()).toBe(true);
    await board.openProjectFilter();
    await expect(page.locator(".board-project-row .board-project-name")).toHaveText(["atlas-api", "web-app"]);
  });

  test("a project filter doesn't follow the switch", async ({ workspaces, page }) => {
    const board = new BoardPageObject(page);
    await board.enter();
    await workspaces.switchTo("Work");
    await board.openProjectFilter();
    await board.toggleProject("web-app");
    await expect(board.cardTitles()).toHaveText(["rate limiter", "auth token refresh"]);
    await workspaces.switchTo("OSS");
    await expect(board.cardTitles()).toHaveText(["nvim lsp config"]);
    expect(await board.projectFilterLabel()).toContain("All projects");
  });

  test("New workspace… checks the name, creates it and switches to it", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.startNewWorkspace("work");
    await workspaces.submitPrompt();
    await expect(workspaces.promptError()).toHaveText('workspace "work" is defined twice');
    await expect(workspaces.promptOverlay()).toBeVisible();

    await page.locator(".confirm-overlay input").fill("  Side ");
    await workspaces.submitPrompt();
    await expect(workspaces.promptOverlay()).toBeHidden();
    await expect(workspaces.chipLabel()).toHaveText("Side");
    await expect(sidebar.titles()).toHaveCount(0);
    expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS", "Side"]);
  });

  test("a workspace deleted elsewhere falls back to Main", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.switchTo("OSS");
    await workspaces.fromTui("delete_workspace", { name: "OSS" });
    await expect(workspaces.chipLabel()).toHaveText("Main");
    // Its project moved to Main with it.
    await expect(sidebar.titles()).toHaveText(["fix login bug", "nvim lsp config"]);
    expect(await workspaces.persistedActive()).toBe(null);
  });

  test("a workspace renamed elsewhere falls back to Main too", async ({ workspaces }) => {
    await workspaces.switchTo("Work");
    await workspaces.fromTui("rename_workspace", { from: "Work", to: "Job" });
    await expect(workspaces.chipLabel()).toHaveText("Main");
    await workspaces.openMenu();
    await expect(workspaces.menuRows().locator(".menu-label")).toHaveText(["Main", "Job", "OSS"]);
  });
});

test.describe("section view", () => {
  test.use({
    seed: (() => {
      const seed = workspacesSeed();
      seed.viewMode = "sections";
      seed.snapshot.section_names = ["Review"];
      seed.snapshot.sections = [
        { name: "In Progress", session_ids: ["sess-1", "proj-atlas-s1", "proj-dot-s1"] },
        { name: "Review", session_ids: ["proj-atlas-s2", "proj-web-s1"] },
      ];
      return seed;
    })(),
  });

  test("section buckets hold only this workspace's sessions", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await expect(sidebar.titles()).toHaveText(["fix login bug"]);
    await workspaces.switchTo("Work");
    await expect(sidebar.titles()).toHaveText(["rate limiter", "auth token refresh", "billing page"]);
    await expect(page.locator("#sessions .project-header .meta")).toHaveText(["1", "2"]);
  });
});

test.describe("startup", () => {
  test.describe("pinned to a workspace", () => {
    test.use({ seed: seedWith({ activeWorkspace: "Work" }, { startup: "OSS" }) });

    test("opens on the pinned workspace, whatever was used last", async ({ workspaces, page }) => {
      await expect(workspaces.chipLabel()).toHaveText("OSS");
      await expect(new SidebarPageObject(page).titles()).toHaveText(["nvim lsp config"]);
    });
  });

  test.describe("on Main", () => {
    test.use({ seed: seedWith({ activeWorkspace: "Work" }, { startup: "main" }) });

    test("opens on Main", async ({ workspaces }) => {
      await expect(workspaces.chipLabel()).toHaveText("Main");
    });
  });

  test.describe("on the last used", () => {
    test.use({ seed: seedWith({ activeWorkspace: "Work" }) });

    test("reopens the workspace used last", async ({ workspaces, page }) => {
      await expect(workspaces.chipLabel()).toHaveText("Work");
      await expect(new SidebarPageObject(page).titles()).toHaveText([
        "rate limiter",
        "auth token refresh",
        "billing page",
      ]);
    });
  });

  test.describe("when the last used has gone", () => {
    test.use({ seed: seedWith({ activeWorkspace: "Gone" }) });

    test("falls back to Main", async ({ workspaces }) => {
      await expect(workspaces.chipLabel()).toHaveText("Main");
      expect(await workspaces.persistedActive()).toBe(null);
    });
  });
});

test.describe("configured keys", () => {
  test.use({ seed: { ...workspacesSeed(), keybindings: { next_workspace: ["w"], previous_workspace: ["b"] } } });

  test("next / previous workspace cycle, wrapping", async ({ workspaces, page }) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("w");
    await expect(workspaces.chipLabel()).toHaveText("Work");
    await page.keyboard.press("b");
    await page.keyboard.press("b");
    await expect(workspaces.chipLabel()).toHaveText("OSS");
  });
});
