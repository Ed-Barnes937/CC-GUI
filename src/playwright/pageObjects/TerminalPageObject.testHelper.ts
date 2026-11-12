import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";

// Drives the terminal tab strip (#tabs) and the xterm panes (#terminals).
// Attaching is a session-row click; the backend's byte stream and pty-exit
// events are simulated through the fake (pushPtyBytes / emitPtyExit).
export class TerminalPageObject extends AppPageObject {
  private readonly tabsEl = this.page.locator("#tabs");
  private readonly tabs = this.tabsEl.locator(".tab");
  private readonly placeholder = this.page.locator("#placeholder");
  private readonly activeScreen = this.page.locator("#terminals .term-container.active .xterm");

  /** Open a terminal by clicking the session row's main area. */
  attach(rowTitle: string): Promise<void> {
    return this.step(`attach: ${rowTitle}`, async () => {
      await this.page
        .locator(".session-row")
        .filter({ has: this.page.locator(".title", { hasText: rowTitle }) })
        .locator(".row-main")
        .click();
      await expect(this.tabs).toHaveCount(1);
    });
  }

  tabCount(): Promise<number> {
    return this.tabs.count();
  }

  tabLabels(): Locator {
    return this.tabs.locator(".tab-label");
  }

  /** Open a session's worktree shell via its row context menu. */
  openShell(rowTitle: string): Promise<void> {
    return this.step(`openShell: ${rowTitle}`, async () => {
      await this.page
        .locator(".session-row")
        .filter({ has: this.page.locator(".title", { hasText: rowTitle }) })
        .click({ button: "right" });
      await this.page.locator(".context-menu .menu-item", { hasText: "Open shell" }).click();
    });
  }

  /** The "❯ Shell" chip a shell tab carries in place of a liveness dot. */
  shellTabChipLabel(): Locator {
    return this.tabsEl.locator(".tab .status-chip.tab-shell .chip-label");
  }

  placeholderVisible(): Promise<boolean> {
    return this.placeholder.isVisible();
  }

  /** Assert the active terminal's rendered screen contains `text` (retries on render). */
  async expectScreenContains(text: string): Promise<void> {
    await expect(this.activeScreen).toContainText(text);
  }

  /** Push UTF-8 text to a session's PTY, as the backend would over the Channel. */
  pushText(name: string, text: string): Promise<void> {
    return this.step(`pushText: ${text}`, () =>
      this.page.evaluate(
        ([n, t]) => {
          const bytes = Array.from(new TextEncoder().encode(t));
          (
            window as unknown as { __CC_SIM__: { pushPtyBytes(name: string, b: number[]): void } }
          ).__CC_SIM__.pushPtyBytes(n, bytes);
        },
        [name, text] as const,
      ),
    );
  }

  /** Fire a pty-exit event (ended=true means the program exited/crashed). */
  emitExit(name: string, ended: boolean): Promise<void> {
    return this.step(`emitExit: ${name} ended=${ended}`, () =>
      this.page.evaluate(
        ([n, e]) =>
          (
            window as unknown as {
              __CC_SIM__: { emitPtyExit(name: string, ended: boolean): Promise<void> };
            }
          ).__CC_SIM__.emitPtyExit(n, e as boolean),
        [name, ended] as const,
      ),
    );
  }

  /** Press a key chord into the active terminal, as a user typing into it. */
  pressInTerminal(chord: string): Promise<void> {
    return this.step(`pressInTerminal: ${chord}`, async () => {
      await expect(
        this.page.locator("#terminals .term-container.active .xterm-helper-textarea"),
      ).toBeFocused();
      await this.page.keyboard.press(chord);
    });
  }

  /** Data the frontend wrote to one session's PTY via write_pty, in order. */
  ptyWrites(name: string): Promise<string[]> {
    return this.page.evaluate(
      (n) =>
        window.__CC_SIM__
          .getPtyWrites()
          .filter((w) => w.tmuxSession === n)
          .map((w) => w.data),
      name,
    );
  }

  closeWithCmdW(): Promise<void> {
    return this.step("closeWithCmdW", () => this.page.keyboard.press("Meta+w"));
  }

  closeActiveTabButton(): Promise<void> {
    return this.step("closeActiveTabButton", () =>
      this.tabsEl.locator(".tab.active .tab-close").click(),
    );
  }
}
