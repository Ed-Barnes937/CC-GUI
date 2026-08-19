import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";

// Drives the settings modal (#settings-overlay), reached via the palette
// "Settings" command. The modal has a single searchable category nav (config
// categories plus the GUI-only Appearance and Features) and a content panel. Only the
// active category's controls are in the DOM, so tests select the category
// before touching a field. Each config control is keyed by its dot-path in
// data-key with a data-kind (toggle / number / text / path / nullable /
// select / string-list). State assertion reads the fake's last save_config
// payload.
export class SettingsModalPageObject extends AppPageObject {
  private readonly overlay = this.page.locator("#settings-overlay");
  private readonly box = this.overlay.locator(".settings-box");

  open(): Promise<void> {
    return this.step("open", async () => {
      await this.page.keyboard.press("ControlOrMeta+k");
      const input = this.page.locator("#palette input");
      await input.fill("Settings");
      await input.press("Enter");
      await expect(this.overlay).toBeVisible();
    });
  }

  selectCategory(id: string): Promise<void> {
    return this.step(`selectCategory ${id}`, () =>
      this.box.locator(`.settings-nav-item[data-cat="${id}"]`).click(),
    );
  }

  /** Type into the nav's search box (filters the category list live). */
  search(query: string): Promise<void> {
    return this.step(`search: ${query}`, () =>
      this.box.locator(".settings-search").fill(query),
    );
  }

  /** Visible nav category labels, top to bottom (the text node after the
   *  icon span). */
  navLabels(): Promise<string[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("#settings-overlay .settings-nav-item")].map(
        (el) => el.lastChild?.textContent?.trim() ?? "",
      ),
    );
  }

  /** The uppercase heading at the top of the content panel. */
  panelHeading(): Locator {
    return this.box.locator(".settings-panel-heading");
  }

  /** Explanatory notes rendered in the content panel, top to bottom. */
  panelNotes(): Promise<string[]> {
    return this.box.locator(".settings-panel .settings-note").allInnerTexts();
  }

  field(key: string): Locator {
    return this.box.locator(`[data-key="${key}"]`);
  }

  fieldKind(key: string): Promise<string | null> {
    return this.field(key).getAttribute("data-kind");
  }

  /** Lowercased tag name of a field's control (input / select / textarea). */
  fieldTag(key: string): Promise<string> {
    return this.field(key).evaluate((el) => el.tagName.toLowerCase());
  }

  setText(key: string, value: string): Promise<void> {
    return this.step(`setText ${key}=${value}`, () => this.field(key).fill(value));
  }

  selectOption(key: string, value: string): Promise<void> {
    return this.step(`selectOption ${key}=${value}`, () =>
      this.field(key).selectOption(value),
    );
  }

  /** Toggle a switch to the desired state (its <input> is visually hidden, so
   *  click the slider rather than calling setChecked on the 0-size input). */
  toggle(key: string, on: boolean): Promise<void> {
    return this.step(`toggle ${key}=${on}`, async () => {
      const input = this.field(key);
      if ((await input.isChecked()) !== on) {
        await this.box.locator(`label.switch:has([data-key="${key}"])`).click();
      }
    });
  }

  // --- sections editor ---

  addSection(): Promise<void> {
    return this.step("addSection", () => this.box.locator(".section-add").click());
  }

  private sectionCard(index: number): Locator {
    return this.box.locator(`.section-card[data-section-index="${index}"]`);
  }

  setSectionField(index: number, field: string, value: string): Promise<void> {
    return this.step(`setSectionField #${index} ${field}=${value}`, () =>
      this.sectionCard(index).locator(`[data-section-field="${field}"]`).fill(value),
    );
  }

  // --- theme tab ---

  setThemeMode(mode: "system" | "light" | "dark"): Promise<void> {
    return this.step(`setThemeMode ${mode}`, () =>
      this.box.locator(`.settings-segment button[data-mode="${mode}"]`).click(),
    );
  }

  themeMode(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem("cc-theme-mode"));
  }

  save(): Promise<void> {
    return this.step("save", async () => {
      await this.box.locator(".editor-buttons button", { hasText: "Save" }).click();
      await expect(this.overlay).toBeHidden();
    });
  }

  cancel(): Promise<void> {
    return this.step("cancel", async () => {
      await this.box.locator(".editor-buttons button", { hasText: "Cancel" }).click();
      await expect(this.overlay).toBeHidden();
    });
  }

  isOpen(): Promise<boolean> {
    return this.overlay.isVisible();
  }

  /** The config the fake last received via save_config (null if never saved). */
  savedConfig(): Promise<Record<string, unknown> | null> {
    return this.page.evaluate(
      () =>
        (
          window as unknown as {
            __CC_SIM__: { getSavedConfig(): Record<string, unknown> | null };
          }
        ).__CC_SIM__.getSavedConfig(),
    );
  }
}
