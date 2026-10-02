import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed, workspacesSeed } from "../../network/seed.testHelper";
import { SidebarPageObject } from "../../../pageObjects/SidebarPageObject.testHelper";
import { SettingsModalPageObject } from "../../../pageObjects/SettingsModalPageObject.testHelper";
import { WorkspaceSettingsPageObject } from "../../../pageObjects/WorkspaceSettingsPageObject.testHelper";
import type { Page } from "@playwright/test";

// Settings › Workspaces (handoff 1d) and deleting a workspace (1e). Every
// control applies at once through its own command (never the pane's Save), so
// assertions read the fake's stored config and project tags.
//
// workspacesSeed(): Main holds acme ("fix login bug"); Work holds atlas-api
// ("rate limiter", "auth token refresh") and web-app ("billing page"); OSS
// holds dotfiles ("nvim lsp config").

/** Open the tab from the chip's "Manage workspaces…". */
async function openTab(page: Page): Promise<WorkspaceSettingsPageObject> {
  const tab = new WorkspaceSettingsPageObject(page);
  await tab.openFromChip();
  return tab;
}

/** GUI view-memory keys, as persisted. */
function viewMemoryKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("cc-workspace-view") ?? "{}")));
}

test.describe("with only Main", () => {
  test.use({ seed: defaultSeed() });

  test("the tab lists Main alone, and adding a workspace brings the chip", async ({ workspaces, page }) => {
    const settings = new SettingsModalPageObject(page);
    const tab = new WorkspaceSettingsPageObject(page);
    await settings.open();
    await settings.selectCategory("workspaces");
    await expect(tab.names()).toHaveText(["Main"]);
    await expect(tab.row("Main").locator(".ws-delete-btn")).toBeHidden();
    await expect(workspaces.chip()).toBeHidden();

    await tab.add("Work");
    await expect(tab.names()).toHaveText(["Main", "Work"]);
    await expect(workspaces.chip()).toBeVisible();
    expect((await workspaces.storedConfig()).defs).toEqual(["Work"]);
  });
});

test.describe("with three workspaces", () => {
  test.use({ seed: workspacesSeed() });

  test("Manage workspaces… opens the tab, after Sections, laid out as the handoff", async ({ workspaces, page }) => {
    const settings = new SettingsModalPageObject(page);
    const tab = await openTab(page);
    const nav = await settings.navLabels();
    expect(nav[nav.indexOf("Sections") + 1]).toBe("Workspaces");
    await expect(tab.activeNav()).toHaveText(/Workspaces/);
    await expect(tab.note()).toHaveText(
      "A workspace is a label on a project. Switching filters the Console and Board to that workspace's projects; sessions elsewhere keep running. Deleting a workspace moves its projects to Main.",
    );
    await expect(tab.names()).toHaveText(["Main", "Work", "OSS"]);
    await expect(tab.rows().locator(".ws-count")).toHaveText(["1 project", "2 projects", "1 project"]);
    await expect(tab.rows().locator(".ws-tag")).toHaveText(["built-in"]);
    await expect(tab.row("Main").locator(".ws-tag")).toHaveText("built-in");
    // Main can be relabelled but neither moved nor deleted.
    await expect(tab.row("Main").locator(".ws-handle")).toBeHidden();
    await expect(tab.row("Main").locator(".ws-delete-btn")).toBeHidden();
    await expect(tab.row("Main").locator(".ws-rename-btn")).toBeVisible();
    await expect(tab.row("Work").locator(".ws-delete-btn")).toBeVisible();
    await expect(tab.addInput()).toHaveAttribute("placeholder", "New workspace name");
    await expect(tab.startupSelect().locator("option")).toHaveText(["Last used", "Main", "Work", "OSS"]);
    await expect(tab.startupSelect()).toHaveValue("last");
    await expect(tab.mainLabelInput()).toHaveValue("Main");
    expect(await workspaces.storedConfig()).toEqual({ defs: ["Work", "OSS"], main: null, startup: "last" });
  });

  test("settings search finds the tab by what it holds", async ({ settings, page }) => {
    await settings.open();
    await settings.search("open on launch");
    expect(await settings.navLabels()).toEqual(["Workspaces"]);
    await expect(settings.panelHeading()).toHaveText("Workspaces");
    await expect(new WorkspaceSettingsPageObject(page).startupSelect()).toBeVisible();
  });

  test.describe("adding", () => {
    test("checks the name inline, then adds it last at once", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.add("oss");
      await expect(tab.errors()).toHaveText(['workspace "oss" is defined twice']);
      await expect(tab.addInput()).toBeFocused();
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS"]);
      await tab.addInput().press("End");
      await tab.addInput().pressSequentially("x");
      await expect(tab.errors()).toHaveCount(0); // a stale complaint goes on edit

      await tab.add("  Side ");
      await expect(tab.names()).toHaveText(["Main", "Work", "OSS", "Side"]);
      await expect(tab.addInput()).toHaveValue("");
      await expect(tab.addInput()).toBeFocused();
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS", "Side"]);
      await expect(tab.startupSelect().locator("option")).toHaveText(["Last used", "Main", "Work", "OSS", "Side"]);
      // Applied, not drafted: closing needs no save and asks nothing.
      await tab.close();
      await workspaces.openMenu();
      await expect(workspaces.menuRows().locator(".menu-label")).toHaveText(["Main", "Work", "OSS", "Side"]);
    });

    test("a name the backend refuses surfaces its message", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      // The TUI creates "Side" and this snapshot hasn't heard yet, so the
      // inline check passes and the backend is the one to refuse.
      await page.evaluate(() => window.__CC_SIM__.handle("create_workspace", { name: "Side" }));
      await tab.add("side");
      await expect(workspaces.lastToast()).toHaveText(`Couldn't create the workspace: workspace "side" is defined twice`);
      await expect(tab.names()).toHaveText(["Main", "Work", "OSS", "Side"]); // and the tab caught up
      await expect(tab.addInput()).toHaveValue("side"); // kept, to fix
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS", "Side"]);
    });
  });

  test.describe("renaming", () => {
    test("renames inline, re-tagging its projects", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.rename("OSS", "Open source");
      await expect(tab.names()).toHaveText(["Main", "Work", "Open source"]);
      await expect(tab.renameInput()).toHaveCount(0);
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "Open source"]);
      expect(await workspaces.workspaceOf("dotfiles")).toBe("Open source");
    });

    test("checks the new name inline, and Escape cancels without closing Settings", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.rename("OSS", "work");
      await expect(tab.errors()).toHaveText(['workspace "work" is defined twice']);
      await expect(tab.renameInput()).toBeFocused();
      await expect(tab.renameInput()).toHaveValue("work");
      await tab.renameInput().press("Escape");
      await expect(tab.renameInput()).toHaveCount(0);
      await expect(tab.errors()).toHaveCount(0);
      expect(await tab.isOpen()).toBe(true);
      await expect(tab.names()).toHaveText(["Main", "Work", "OSS"]);
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS"]);
    });

    test("re-casing its own name is allowed", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.rename("OSS", "oss");
      await expect(tab.names()).toHaveText(["Main", "Work", "oss"]);
      expect(await workspaces.workspaceOf("dotfiles")).toBe("oss");
    });

    test("renaming the active workspace keeps it active, with its view memory", async ({ workspaces, page }) => {
      const sidebar = new SidebarPageObject(page);
      await workspaces.switchTo("OSS");
      await sidebar.row("nvim lsp config").click();
      await workspaces.switchTo("Main"); // OSS's cursor is remembered as it's left
      await workspaces.switchTo("OSS");
      await expect(sidebar.row("nvim lsp config")).toHaveClass(/selected/);

      const tab = await openTab(page);
      await tab.rename("OSS", "Open");
      await expect(tab.names()).toHaveText(["Main", "Work", "Open"]);
      await tab.close();
      await expect(workspaces.chipLabel()).toHaveText("Open");
      await expect(sidebar.titles()).toHaveText(["nvim lsp config"]);
      await expect(sidebar.row("nvim lsp config")).toHaveClass(/selected/);
      expect(await workspaces.persistedActive()).toBe("Open");

      // Its remembered view moved with the name.
      await workspaces.switchTo("Main");
      expect(await viewMemoryKeys(page)).toContain("Open");
      expect(await viewMemoryKeys(page)).not.toContain("OSS");
      await workspaces.switchTo("Open");
      await expect(sidebar.row("nvim lsp config")).toHaveClass(/selected/);
    });

    test("Main's row relabels Main", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.rename("Main", "Home");
      await expect(tab.names()).toHaveText(["Home", "Work", "OSS"]);
      await expect(tab.mainLabelInput()).toHaveValue("Home");
      expect((await workspaces.storedConfig()).main).toBe("Home");
    });
  });

  test.describe("reordering", () => {
    test("arrow keys on the handle move a workspace, focus following it", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.nudge("Work", "ArrowDown");
      await expect(tab.names()).toHaveText(["Main", "OSS", "Work"]);
      await expect(tab.row("Work").locator(".ws-handle")).toBeFocused();
      expect((await workspaces.storedConfig()).defs).toEqual(["OSS", "Work"]);

      // Main stays first: the top named workspace can't go above it.
      await tab.nudge("OSS", "ArrowUp");
      await expect(tab.names()).toHaveText(["Main", "OSS", "Work"]);
      expect((await workspaces.storedConfig()).defs).toEqual(["OSS", "Work"]);

      await tab.close();
      await workspaces.openMenu();
      await expect(workspaces.menuRows().locator(".menu-label")).toHaveText(["Main", "OSS", "Work"]);
      await expect(workspaces.menuRows().locator(".menu-shortcut")).toHaveText(["⌘⇧1", "⌘⇧2", "⌘⇧3"]);
    });

    test("dragging the handle moves a workspace", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.dragAbove("OSS", "Work");
      await expect(tab.names()).toHaveText(["Main", "OSS", "Work"]);
      await expect(tab.rows().and(page.locator(".drop-before, .drop-after, .dragging"))).toHaveCount(0);
      expect((await workspaces.storedConfig()).defs).toEqual(["OSS", "Work"]);
    });
  });

  test.describe("deleting", () => {
    test("asks first, naming the projects that move to Main", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.startDelete("Work");
      await expect(tab.confirmText()).toHaveText(
        'Delete workspace "Work"?\nIts 2 projects (atlas-api, web-app) move to Main. No sessions are stopped.',
      );
      await expect(tab.confirmOverlay().locator(".confirm-box")).toHaveCSS("width", "380px");
      await expect(tab.confirmOverlay().locator("button.danger")).toHaveText("Delete");
      await tab.cancelDelete();
      expect(await tab.isOpen()).toBe(true);
      expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS"]);

      await tab.startDelete("Work");
      await tab.confirmDelete();
      await expect(tab.names()).toHaveText(["Main", "OSS"]);
      await expect(tab.row("Main").locator(".ws-count")).toHaveText("3 projects");
      expect((await workspaces.storedConfig()).defs).toEqual(["OSS"]);
      expect(await workspaces.workspaceOf("atlas-api")).toBeNull();
      expect(await workspaces.workspaceOf("web-app")).toBeNull();
    });

    test("uses Main's label and singular copy", async ({ workspaces, page }) => {
      await workspaces.fromTui("set_main_workspace_label", { label: "Home" });
      const tab = await openTab(page);
      await tab.startDelete("OSS");
      await expect(tab.confirmText()).toHaveText(
        'Delete workspace "OSS"?\nIts 1 project (dotfiles) moves to Home. No sessions are stopped.',
      );
    });

    test("deleting the active workspace switches to Main first", async ({ workspaces, page }) => {
      const sidebar = new SidebarPageObject(page);
      await workspaces.switchTo("OSS");
      await sidebar.row("nvim lsp config").click();
      const tab = await openTab(page);
      await tab.startDelete("OSS");
      await tab.confirmDelete();
      await expect(tab.names()).toHaveText(["Main", "Work"]);
      await tab.close();
      await expect(workspaces.chipLabel()).toHaveText("Main");
      expect(await workspaces.persistedActive()).toBeNull();
      await expect(sidebar.titles()).toHaveText(["fix login bug", "nvim lsp config"]);
      expect(await viewMemoryKeys(page)).not.toContain("OSS");
    });

    test("a pin on the deleted workspace falls back to Main", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.startupSelect().selectOption("OSS");
      await expect.poll(async () => (await workspaces.storedConfig()).startup).toBe("OSS");
      await tab.startDelete("OSS");
      await tab.confirmDelete();
      await expect(tab.startupSelect()).toHaveValue("main");
      expect((await workspaces.storedConfig()).startup).toBe("main");
    });
  });

  test("Open on launch applies at once", async ({ workspaces, page }) => {
    const tab = await openTab(page);
    await tab.startupSelect().selectOption("Work");
    await expect.poll(async () => (await workspaces.storedConfig()).startup).toBe("Work");
    await tab.startupSelect().selectOption("main");
    await expect.poll(async () => (await workspaces.storedConfig()).startup).toBe("main");
    await tab.close();
    expect((await workspaces.storedConfig()).startup).toBe("main");
  });

  test.describe("Main label", () => {
    test("applies on Enter, everywhere Main is named", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.mainLabelInput().fill("Home");
      await tab.mainLabelInput().press("Enter");
      await expect(tab.names()).toHaveText(["Home", "Work", "OSS"]);
      await expect(tab.startupSelect().locator("option")).toHaveText(["Last used", "Home", "Work", "OSS"]);
      expect((await workspaces.storedConfig()).main).toBe("Home");
      await tab.close();
      await expect(workspaces.chipLabel()).toHaveText("Home");
    });

    test("checks the label inline and Escape puts it back", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.mainLabelInput().fill("work");
      await tab.mainLabelInput().press("Enter");
      await expect(tab.errors()).toHaveText(['workspace "Work" is defined twice']);
      await expect(tab.mainLabelInput()).toBeFocused();
      await tab.mainLabelInput().press("Escape");
      await expect(tab.mainLabelInput()).toHaveValue("Main");
      await expect(tab.errors()).toHaveCount(0);
      expect(await tab.isOpen()).toBe(true);
      expect((await workspaces.storedConfig()).main).toBeNull();
    });
  });

  test.describe("while open", () => {
    test("follows edits from the TUI", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await workspaces.fromTui("rename_workspace", { from: "Work", to: "Job" });
      await expect(tab.names()).toHaveText(["Main", "Job", "OSS"]);
      await workspaces.fromTui("set_project_workspace", { projectId: "proj-dot", workspace: "Job" });
      await expect(tab.rows().locator(".ws-count")).toHaveText(["1 project", "3 projects", "0 projects"]);
    });

    test("keeps what's being typed across a snapshot", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.startRename("OSS", "Open");
      await workspaces.fromTui("create_workspace", { name: "Side" });
      await expect(tab.names()).toHaveText(["Main", "Work", "Side"]); // OSS's row is the open field
      await expect(tab.renameInput()).toHaveValue("Open");
      await expect(tab.renameInput()).toBeFocused();
      await tab.renameInput().press("Enter");
      await expect(tab.names()).toHaveText(["Main", "Work", "Open", "Side"]);
    });

    test("drops a rename whose workspace was deleted elsewhere", async ({ workspaces, page }) => {
      const tab = await openTab(page);
      await tab.startRename("OSS", "Open");
      await workspaces.fromTui("delete_workspace", { name: "OSS" });
      await expect(tab.renameInput()).toHaveCount(0);
      await expect(tab.names()).toHaveText(["Main", "Work"]);
    });

    test("a workspace deleted from the TUI drops the GUI's view memory for it", async ({ workspaces, page }) => {
      const sidebar = new SidebarPageObject(page);
      await workspaces.switchTo("OSS");
      await sidebar.row("nvim lsp config").click();
      await workspaces.switchTo("Main");
      expect(await viewMemoryKeys(page)).toContain("OSS");
      await workspaces.fromTui("delete_workspace", { name: "OSS" });
      await expect.poll(() => viewMemoryKeys(page)).not.toContain("OSS");
    });
  });
});
