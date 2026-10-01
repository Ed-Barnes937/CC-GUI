import { test, expect } from "../../support/fixture.testHelper";
import { defaultSeed, workspacesSeed } from "../../network/seed.testHelper";
import { SidebarPageObject } from "../../../pageObjects/SidebarPageObject.testHelper";
import { TerminalPageObject } from "../../../pageObjects/TerminalPageObject.testHelper";
import { BoardPageObject } from "../../../pageObjects/BoardPageObject.testHelper";
import { PalettePageObject } from "../../../pageObjects/PalettePageObject.testHelper";

// Moving a project to another workspace (handoff 1c): the project header's
// "Move to workspace" submenu, dragging the header onto the chip, the toast
// that follows, and new projects landing in the workspace on screen.
//
// workspacesSeed(): Main holds acme ("fix login bug"); Work holds atlas-api
// ("rate limiter", "auth token refresh") and web-app ("billing page"); OSS
// holds dotfiles ("nvim lsp config").

test.describe("with only Main", () => {
  test.use({ seed: defaultSeed() });

  test("the project menu has no Move to workspace entry", async ({ workspaces }) => {
    await workspaces.openProjectMenu("acme");
    await expect(workspaces.contextMenu().locator(".menu-item .menu-label")).toHaveText([
      "New session…",
      "Project shell",
      "Remove project (deletes all its sessions)",
    ]);
  });
});

test.describe("from the project menu", () => {
  test.use({ seed: workspacesSeed() });

  test("Move to workspace sits between Project shell and Remove project", async ({ workspaces }) => {
    await workspaces.openProjectMenu("acme");
    await expect(workspaces.contextMenu().locator(".menu-item .menu-label")).toHaveText([
      "New session…",
      "Project shell",
      "Move to workspace",
      "Remove project (deletes all its sessions)",
    ]);
    await expect(workspaces.contextMenu().locator(".menu-separator")).toHaveCount(2);
  });

  test("the submenu lists every workspace, the current one ticked, dimmed and tagged", async ({
    workspaces,
  }) => {
    await workspaces.openMoveSubmenu("acme");
    const sub = workspaces.submenu();
    await expect(sub.locator(".menu-item.checkable .menu-label")).toHaveText(["Main", "Work", "OSS"]);
    const current = workspaces.workspaceRow(sub, "Main");
    await expect(current).toHaveAttribute("aria-checked", "true");
    await expect(current).toHaveClass(/disabled/);
    await expect(current.locator(".menu-tag")).toHaveText("current");
    await expect(sub.locator(".menu-tag")).toHaveCount(1);
    await expect(sub.locator(".menu-item.indent")).toHaveText("New workspace…");
    await expect(workspaces.contextMenu().locator(".menu-item.open")).toHaveText(/Move to workspace/);
  });

  test("picking the current workspace does nothing", async ({ workspaces }) => {
    await workspaces.openMoveSubmenu("acme");
    // aria-disabled, so Playwright would refuse a plain click; a user can still click it.
    await workspaces.workspaceRow(workspaces.submenu(), "Main").click({ force: true });
    await expect(workspaces.submenu()).toBeVisible();
    expect(await workspaces.workspaceOf("acme")).toBeNull();
  });

  test("moving takes the project out of view and the toast follows it there", async ({
    workspaces,
    page,
  }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.moveViaMenu("acme", "OSS");
    await expect(sidebar.titles()).toHaveCount(0);
    await expect(workspaces.projectHeader("acme")).toHaveCount(0);
    expect(await workspaces.workspaceOf("acme")).toBe("OSS");
    await expect(workspaces.chipLabel()).toHaveText("Main"); // a move doesn't switch
    await expect(workspaces.countPill()).toHaveText("0 sessions · 0 live");

    const toast = workspaces.lastToast();
    await expect(toast).toContainText("Moved acme to OSS");
    await toast.locator(".toast-action").click();
    await expect(workspaces.chipLabel()).toHaveText("OSS");
    await expect(sidebar.titles()).toHaveText(["fix login bug", "nvim lsp config"]);
    await expect(toast).toHaveCount(0);
  });

  test("New workspace… checks the name, creates it and moves the project in", async ({
    workspaces,
    page,
  }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.openMoveSubmenu("acme");
    await workspaces.submenu().locator(".menu-item", { hasText: "New workspace…" }).click();
    await expect(workspaces.promptOverlay()).toBeVisible();
    await page.locator(".confirm-overlay input").fill("oss");
    await workspaces.submitPrompt();
    await expect(workspaces.promptError()).toHaveText('workspace "oss" is defined twice');

    await page.locator(".confirm-overlay input").fill(" Side ");
    await workspaces.submitPrompt();
    await expect(workspaces.promptOverlay()).toBeHidden();
    await expect(workspaces.lastToast()).toContainText("Moved acme to Side");
    await expect(sidebar.titles()).toHaveCount(0);
    expect(await workspaces.workspaceOf("acme")).toBe("Side");
    expect((await workspaces.storedConfig()).defs).toEqual(["Work", "OSS", "Side"]);
    await workspaces.openMenu();
    await expect(workspaces.menuRows().locator(".menu-label")).toHaveText(["Main", "Work", "OSS", "Side"]);
  });

  test("a project moved with its terminal open keeps it attached, out of the strip", async ({
    workspaces,
    page,
  }) => {
    const terminal = new TerminalPageObject(page);
    const sidebar = new SidebarPageObject(page);
    await terminal.attach("fix login bug");
    await expect(sidebar.row("fix login bug")).toHaveClass(/selected/);

    await workspaces.moveViaMenu("acme", "Work");
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveCount(0);
    expect(await terminal.placeholderVisible()).toBe(true);
    expect(await workspaces.attachedPtys()).toEqual(["cc-sess-1"]);

    await workspaces.lastToast().locator(".toast-action").click();
    await expect(workspaces.chipLabel()).toHaveText("Work");
    await expect(terminal.tabLabels().filter({ visible: true })).toHaveText(["fix login bug"]);
  });

  test("the Board loses the moved project's cards and filter entry", async ({ workspaces, page }) => {
    const board = new BoardPageObject(page);
    await workspaces.switchTo("Work");
    await workspaces.moveViaMenu("web-app", "OSS");
    await board.enter();
    await expect(board.cardTitles()).toHaveText(["rate limiter", "auth token refresh"]);
    await board.openProjectFilter();
    await expect(page.locator(".board-project-row .board-project-name")).toHaveText(["atlas-api"]);
  });

  test("a Board filtered to only a project moved elsewhere falls back to every project", async ({
    workspaces,
    page,
  }) => {
    const board = new BoardPageObject(page);
    await workspaces.switchTo("Work");
    await board.enter();
    await board.openProjectFilter();
    await board.toggleProject("atlas-api"); // only web-app left picked
    await expect(board.cardTitles()).toHaveText(["billing page"]);
    await workspaces.fromTui("set_project_workspace", { projectId: "proj-web", workspace: "OSS" });
    await expect(board.cardTitles()).toHaveText(["rate limiter", "auth token refresh"]);
    expect(await board.projectFilterLabel()).toContain("All projects");
  });
});

test.describe("from the keyboard and the palette", () => {
  test.use({ seed: { ...workspacesSeed(), keybindings: { move_project_to_workspace: ["M"] } } });

  test("the move key opens the move menu for the cursor's project", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await sidebar.row("fix login bug").click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Shift+M");
    await expect(workspaces.menu().locator(".menu-header")).toHaveText("Move acme to");
    await workspaces.workspaceRow(workspaces.menu(), "Work").click();
    await expect(workspaces.lastToast()).toContainText("Moved acme to Work");
    expect(await workspaces.workspaceOf("acme")).toBe("Work");
  });

  test("the palette offers the move for the cursor's project", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    const palette = new PalettePageObject(page);
    await sidebar.row("fix login bug").click();
    await palette.open();
    await palette.type("Move project");
    await palette.clickRow("Move project to workspace…");
    await expect(workspaces.menu().locator(".menu-header")).toHaveText("Move acme to");
    await workspaces.workspaceRow(workspaces.menu(), "OSS").click();
    expect(await workspaces.workspaceOf("acme")).toBe("OSS");
  });
});

test.describe("by dragging onto the chip", () => {
  test.use({ seed: workspacesSeed() });

  test("the chip opens its menu as a drop target and a drop moves the project", async ({
    workspaces,
    page,
  }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.dragProjectToChip("acme");
    await expect(workspaces.chip()).toHaveClass(/drag-over/);
    await expect(workspaces.menu()).toBeVisible();
    await expect(workspaces.projectHeader("acme")).toHaveClass(/dragging/);
    await expect(workspaces.dragGhost()).toHaveText(/acme/);
    await expect(workspaces.dragGhost().locator(".ghost-target")).toHaveText("→ move to workspace");
    // Nothing to drop on in Manage, so the drop menu leaves it out.
    await expect(workspaces.menu().locator(".menu-item.indent")).toHaveText(["New workspace…"]);
    await expect(workspaces.workspaceRow(workspaces.menu(), "Main")).toHaveClass(/disabled/);

    await workspaces.hoverDropRow("OSS");
    await expect(workspaces.workspaceRow(workspaces.menu(), "OSS")).toHaveClass(/drop-hover/);
    await expect(workspaces.dragGhost().locator(".ghost-target")).toHaveText("→ move to OSS");
    await workspaces.release();

    await expect(workspaces.menu()).toBeHidden();
    await expect(workspaces.dragGhost()).toHaveCount(0);
    await expect(workspaces.chip()).not.toHaveClass(/drag-over/);
    await expect(sidebar.titles()).toHaveCount(0);
    expect(await workspaces.workspaceOf("acme")).toBe("OSS");
    await expect(workspaces.lastToast()).toContainText("Moved acme to OSS");
  });

  test("dropping on the project's own workspace moves nothing", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.dragProjectToChip("acme");
    await workspaces.hoverDropRow("Main");
    await expect(workspaces.dragGhost().locator(".ghost-target")).toHaveText("→ move to workspace");
    await workspaces.release();
    await expect(workspaces.menu()).toBeHidden();
    await expect(sidebar.titles()).toHaveText(["fix login bug"]);
    expect(await workspaces.workspaceOf("acme")).toBeNull();
  });

  test("Esc cancels the drag, leaving everything as it was", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.dragProjectToChip("acme");
    await workspaces.hoverDropRow("Work");
    await page.keyboard.press("Escape");
    await expect(workspaces.menu()).toBeHidden();
    await expect(workspaces.dragGhost()).toHaveCount(0);
    await expect(workspaces.projectHeader("acme")).not.toHaveClass(/dragging/);
    await workspaces.release();
    await expect(sidebar.titles()).toHaveText(["fix login bug"]);
    expect(await workspaces.workspaceOf("acme")).toBeNull();
  });

  test("dropping on New workspace… asks for a name, then moves the project there", async ({
    workspaces,
    page,
  }) => {
    await workspaces.dragProjectToChip("acme");
    await workspaces.hoverDropRow("New workspace…");
    await expect(workspaces.dragGhost().locator(".ghost-target")).toHaveText("→ move to a new workspace");
    await workspaces.release();
    await expect(workspaces.promptOverlay()).toBeVisible();
    await page.locator(".confirm-overlay input").fill("Side");
    await workspaces.submitPrompt();
    await expect(workspaces.lastToast()).toContainText("Moved acme to Side");
    expect(await workspaces.workspaceOf("acme")).toBe("Side");
  });
});

test.describe("new projects", () => {
  test.use({ seed: { ...workspacesSeed(), dirs: ["/repos/fresh", "/scan/one", "/scan/two"] } });

  test("an added project lands in the workspace on screen", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await workspaces.switchTo("OSS");
    await sidebar.openAddProject();
    await sidebar.typePath("/repos/fresh");
    await sidebar.pressInPath("Enter");
    await expect(workspaces.projectHeader("fresh")).toBeVisible();
    expect(await workspaces.workspaceOf("fresh")).toBe("OSS");
  });

  test("a scan's repos land in the workspace on screen", async ({ workspaces, page }) => {
    await workspaces.switchTo("Work");
    await page.locator("#sidebar-menu").click();
    await page.locator(".context-menu .menu-item", { hasText: "Scan directory for repos…" }).click();
    await page.locator("#sessions .path-input input").fill("/scan");
    await page.locator("#sessions .path-input input").press("Enter");
    await expect(workspaces.lastToast()).toContainText("Scan complete: 2 added, 0 already present");
    expect(await workspaces.workspaceOf("one")).toBe("Work");
    expect(await workspaces.workspaceOf("two")).toBe("Work");
  });

  test("on Main, a new project stays untagged", async ({ workspaces, page }) => {
    const sidebar = new SidebarPageObject(page);
    await sidebar.openAddProject();
    await sidebar.typePath("/repos/fresh");
    await sidebar.pressInPath("Enter");
    await expect(workspaces.projectHeader("fresh")).toBeVisible();
    expect(await workspaces.workspaceOf("fresh")).toBeNull();
  });
});
