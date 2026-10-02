import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";

// Drives the title bar's workspace chip and its menu, and reads the fake's
// workspace state (the stored config, attached PTYs) for assertions. Edits
// "from the TUI" go straight to the fake's command surface, then push.
export class WorkspacesPageObject extends AppPageObject {
  private readonly chipEl = this.page.locator("#tb-workspace");
  private readonly menuEl = this.page.locator(".context-menu.workspace-menu");
  private readonly prompt = this.page.locator(".confirm-overlay");

  /** The title-bar chip (hidden until a second workspace exists). */
  chip(): Locator {
    return this.chipEl;
  }

  /** The active workspace's label, as the chip shows it. */
  chipLabel(): Locator {
    return this.chipEl.locator(".tb-workspace-label");
  }

  /** The title bar's "N sessions · N live" pill. */
  countPill(): Locator {
    return this.page.locator("#tb-count");
  }

  menu(): Locator {
    return this.menuEl;
  }

  /** The menu's workspace rows (the ticking ones), in order. */
  menuRows(): Locator {
    return this.menuEl.locator(".menu-item.checkable");
  }

  /** The workspace row that carries the tick. */
  tickedRow(): Locator {
    return this.menuEl.locator('.menu-item[aria-checked="true"]');
  }

  openMenu(): Promise<void> {
    return this.step("openMenu", async () => {
      await this.chipEl.click();
      await expect(this.menuEl).toBeVisible();
    });
  }

  /** Switch through the chip's menu. */
  switchTo(label: string): Promise<void> {
    return this.step(`switchTo: ${label}`, async () => {
      await this.openMenu();
      await this.menuRows().filter({ has: this.page.locator(".menu-label", { hasText: label }) }).click();
      await expect(this.chipLabel()).toHaveText(label);
    });
  }

  /** Switch with Cmd+Shift+N (1-based, display order). */
  switchByNumber(n: number): Promise<void> {
    return this.step(`switchByNumber: ${n}`, () => this.page.keyboard.press(`Meta+Shift+Digit${n}`));
  }

  /** Start "New workspace…" from the menu and type a name (not yet submitted). */
  startNewWorkspace(name: string): Promise<void> {
    return this.step(`startNewWorkspace: ${name}`, async () => {
      await this.openMenu();
      await this.menuEl.locator(".menu-item", { hasText: "New workspace…" }).click();
      await expect(this.prompt).toBeVisible();
      await this.prompt.locator("input").fill(name);
    });
  }

  submitPrompt(): Promise<void> {
    return this.step("submitPrompt", () => this.prompt.locator("input").press("Enter"));
  }

  /** The prompt's inline validation message. */
  promptError(): Locator {
    return this.prompt.locator(".confirm-error");
  }

  promptOverlay(): Locator {
    return this.prompt;
  }

  /** The fake's stored workspace config. */
  storedConfig(): Promise<{ defs: string[]; main: string | null; startup: string }> {
    return this.page.evaluate(() => window.__CC_SIM__.getWorkspaceConfig());
  }

  /** What the GUI persisted as its last-used workspace. */
  persistedActive(): Promise<string | null> {
    return this.page.evaluate(() => JSON.parse(localStorage.getItem("cc-active-workspace") ?? "null"));
  }

  /** tmux sessions the fake still has a PTY attached for. */
  attachedPtys(): Promise<string[]> {
    return this.page.evaluate(() => window.__CC_SIM__.getAttachedPtys());
  }

  // ----- moving a project (handoff 1c) -----

  /** A project's header in the sidebar's project view (its name follows the
   *  collapse caret). */
  projectHeader(name: string): Locator {
    return this.page
      .locator("#sessions .project-header")
      .filter({ has: this.page.locator("span", { hasText: new RegExp(`(^|\\s)${name}$`) }) });
  }

  /** The open project-header (or session) context menu. */
  contextMenu(): Locator {
    return this.page.locator(".context-menu:not(.submenu):not(.workspace-menu)");
  }

  /** The "Move to workspace ▸" submenu, once open. */
  submenu(): Locator {
    return this.page.locator(".context-menu.submenu");
  }

  /** A submenu's (or the move menu's) workspace row by its label. */
  workspaceRow(menu: Locator, label: string): Locator {
    return menu.locator(".menu-item.checkable").filter({
      has: this.page.locator(".menu-label", { hasText: new RegExp(`^${label}$`) }),
    });
  }

  /** Right-click a project header. */
  openProjectMenu(name: string): Promise<void> {
    return this.step(`openProjectMenu: ${name}`, async () => {
      await this.projectHeader(name).click({ button: "right" });
      await expect(this.contextMenu()).toBeVisible();
    });
  }

  /** Right-click a project header and open its "Move to workspace" submenu. */
  openMoveSubmenu(name: string): Promise<void> {
    return this.step(`openMoveSubmenu: ${name}`, async () => {
      await this.openProjectMenu(name);
      await this.contextMenu().locator(".menu-item", { hasText: "Move to workspace" }).hover();
      await expect(this.submenu()).toBeVisible();
    });
  }

  /** Move a project through its header's submenu. */
  moveViaMenu(name: string, to: string): Promise<void> {
    return this.step(`moveViaMenu: ${name} → ${to}`, async () => {
      await this.openMoveSubmenu(name);
      await this.workspaceRow(this.submenu(), to).click();
    });
  }

  /** Press on a project header and drag it onto the workspace chip, leaving
   *  the button held (the drop menu open) for drop / cancel. */
  dragProjectToChip(name: string): Promise<void> {
    return this.step(`dragProjectToChip: ${name}`, async () => {
      const a = await this.projectHeader(name).boundingBox();
      const b = await this.chipEl.boundingBox();
      if (!a || !b) throw new Error("dragProjectToChip: header or chip not visible");
      const { mouse } = this.page;
      await mouse.move(a.x + 20, a.y + a.height / 2);
      await mouse.down();
      await mouse.move(a.x + 26, a.y + a.height / 2, { steps: 3 }); // cross the threshold
      await mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    });
  }

  /** With a drag held, move the pointer over the drop menu's row `label`. */
  hoverDropRow(label: string): Promise<void> {
    return this.step(`hoverDropRow: ${label}`, async () => {
      const row = this.menuEl.locator(".menu-item", { hasText: label }).first();
      const box = await row.boundingBox();
      if (!box) throw new Error(`hoverDropRow: no row ${label}`);
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    });
  }

  /** Release the held drag where the pointer is. */
  release(): Promise<void> {
    return this.step("release", () => this.page.mouse.up());
  }

  /** The ghost that follows a dragged project header. */
  dragGhost(): Locator {
    return this.page.locator(".project-drag-ghost");
  }

  /** The newest toast. */
  lastToast(): Locator {
    return this.page.locator("#toast-stack .toast").last();
  }

  /** Projects the fake holds, with their workspace tags (null = Main). */
  storedProjects(): Promise<{ id: string; name: string; repo_path: string; workspace: string | null }[]> {
    return this.page.evaluate(() => window.__CC_SIM__.getProjects());
  }

  /** The fake's tag on the project named `name` (null = Main). */
  async workspaceOf(name: string): Promise<string | null | undefined> {
    return (await this.storedProjects()).find((p) => p.name === name)?.workspace;
  }

  /** Run a backend command as another client (the TUI) would, then push the
   *  resulting snapshot. */
  fromTui(cmd: string, args: Record<string, unknown>): Promise<void> {
    return this.step(`fromTui: ${cmd}`, () =>
      this.page.evaluate(
        async ([c, a]) => {
          window.__CC_SIM__.handle(c, a);
          await window.__CC_SIM__.pushState();
        },
        [cmd, args] as const,
      ),
    );
  }
}
