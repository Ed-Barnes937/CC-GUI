import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";

// Drives the file explorer overlay (#file-explorer). Keys go to the focused
// list (#fx-list), matching the module's own keydown handler.
export class FileExplorerPageObject extends AppPageObject {
  private readonly pane = this.page.locator("#file-explorer");
  private readonly list = this.page.locator("#fx-list");
  private readonly crumbs = this.page.locator("#fx-crumbs");
  private readonly count = this.page.locator("#fx-count");
  private readonly search = this.page.locator("#fx-filter");

  paneLocator(): Locator {
    return this.pane;
  }

  /** Open the explorer with Cmd+E (works even while the terminal is focused). */
  open(): Promise<void> {
    return this.step("open", async () => {
      await this.page.keyboard.press("Meta+e");
      await expect(this.pane).toBeVisible();
      // Wait for the first listing to render (count is set by render()) so the
      // list is focused and cursor reads are stable before keys are sent.
      await expect(this.count).not.toHaveText("");
    });
  }

  press(key: string): Promise<void> {
    return this.step(`press: ${key}`, () => this.page.keyboard.press(key));
  }

  /** The "⌕ query" indicator — visible only while a repo-wide search is live. */
  searchLocator(): Locator {
    return this.search;
  }

  /** Type a run of characters, one keydown each (drives the repo-wide search). */
  type(text: string): Promise<void> {
    return this.step(`type: ${text}`, () => this.page.keyboard.type(text));
  }

  rows(): Locator {
    return this.list.locator(".fx-row");
  }

  row(name: string): Locator {
    return this.list.locator(".fx-row", { hasText: name });
  }

  /** Name shown on the cursor (highlighted) row. */
  cursorName(): Promise<string> {
    return this.list.locator(".fx-row.cursor .fx-name").innerText();
  }

  crumbsText(): Promise<string> {
    return this.crumbs.innerText();
  }

  countText(): Promise<string> {
    return this.count.innerText();
  }

  /** Bytes the frontend wrote to PTYs — where the @path reference lands. */
  ptyWrites(): Promise<{ tmuxSession: string; data: string }[]> {
    return this.page.evaluate(
      () =>
        (
          window as unknown as {
            __CC_SIM__: { getPtyWrites(): { tmuxSession: string; data: string }[] };
          }
        ).__CC_SIM__.getPtyWrites(),
    );
  }
}
