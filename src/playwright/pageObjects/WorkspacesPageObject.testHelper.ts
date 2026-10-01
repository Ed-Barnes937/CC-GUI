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
