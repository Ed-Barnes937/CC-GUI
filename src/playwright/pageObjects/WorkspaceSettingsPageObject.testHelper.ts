import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";

// Drives Settings › Workspaces (handoff 1d) and the delete confirm (1e). Every
// control there applies at once through its own backend command, so state is
// asserted on the fake's workspace config and project tags, not on a save.
export class WorkspaceSettingsPageObject extends AppPageObject {
  private readonly overlay = this.page.locator("#settings-overlay");
  private readonly panel = this.overlay.locator(".settings-panel");
  private readonly confirm = this.page.locator(".confirm-overlay");

  /** Open it the way the chip's menu does ("Manage workspaces…"). */
  openFromChip(): Promise<void> {
    return this.step("openFromChip", async () => {
      await this.page.locator("#tb-workspace").click();
      await this.page.locator(".workspace-menu .menu-item", { hasText: "Manage workspaces…" }).click();
      await expect(this.overlay).toBeVisible();
      await expect(this.heading()).toHaveText("Workspaces");
    });
  }

  heading(): Locator {
    return this.panel.locator(".settings-panel-heading");
  }

  note(): Locator {
    return this.panel.locator(".settings-note");
  }

  /** The nav entry that's showing. */
  activeNav(): Locator {
    return this.overlay.locator(".settings-nav-item.active");
  }

  rows(): Locator {
    return this.panel.locator(".ws-row");
  }

  /** The rows' names, top to bottom (a row being renamed shows its input). */
  names(): Locator {
    return this.panel.locator(".ws-row .ws-name");
  }

  /** A row by its workspace's label. */
  row(label: string): Locator {
    return this.rows().filter({ has: this.page.locator(".ws-name", { hasText: new RegExp(`^${label}$`) }) });
  }

  /** The row being renamed. */
  renamingRow(): Locator {
    return this.rows().filter({ has: this.page.locator(".ws-rename-input") });
  }

  renameInput(): Locator {
    return this.panel.locator(".ws-rename-input");
  }

  addInput(): Locator {
    return this.panel.locator("#ws-add");
  }

  startupSelect(): Locator {
    return this.panel.locator("#ws-startup");
  }

  mainLabelInput(): Locator {
    return this.panel.locator("#ws-main-label");
  }

  /** Inline validation messages, top to bottom. */
  errors(): Locator {
    return this.panel.locator(".ws-error");
  }

  add(name: string): Promise<void> {
    return this.step(`add: ${name}`, async () => {
      await this.addInput().fill(name);
      await this.panel.locator(".ws-add-btn").click();
    });
  }

  /** Open the inline rename on `label`'s row and type `to` (not committed). */
  startRename(label: string, to: string): Promise<void> {
    return this.step(`startRename: ${label} → ${to}`, async () => {
      await this.row(label).locator(".ws-rename-btn").click();
      await expect(this.renameInput()).toBeFocused();
      await this.renameInput().fill(to);
    });
  }

  rename(label: string, to: string): Promise<void> {
    return this.step(`rename: ${label} → ${to}`, async () => {
      await this.startRename(label, to);
      await this.renameInput().press("Enter");
    });
  }

  /** Press ✕ on `label`'s row, leaving the confirm open. */
  startDelete(label: string): Promise<void> {
    return this.step(`startDelete: ${label}`, async () => {
      await this.row(label).locator(".ws-delete-btn").click();
      await expect(this.confirm).toBeVisible();
    });
  }

  confirmOverlay(): Locator {
    return this.confirm;
  }

  confirmText(): Locator {
    return this.confirm.locator(".confirm-text");
  }

  confirmDelete(): Promise<void> {
    return this.step("confirmDelete", async () => {
      await this.confirm.locator("button", { hasText: "Delete" }).click();
      await expect(this.confirm).toBeHidden();
    });
  }

  cancelDelete(): Promise<void> {
    return this.step("cancelDelete", async () => {
      await this.confirm.locator("button", { hasText: "Cancel" }).click();
      await expect(this.confirm).toBeHidden();
    });
  }

  /** Focus `label`'s ⋮⋮ handle and press an arrow key. */
  nudge(label: string, key: "ArrowUp" | "ArrowDown"): Promise<void> {
    return this.step(`nudge: ${label} ${key}`, async () => {
      await this.row(label).locator(".ws-handle").focus();
      await this.page.keyboard.press(key);
    });
  }

  /** Drag `label`'s handle to just above `above`'s row and release. */
  dragAbove(label: string, above: string): Promise<void> {
    return this.step(`dragAbove: ${label} → ${above}`, async () => {
      const a = await this.row(label).locator(".ws-handle").boundingBox();
      const b = await this.row(above).boundingBox();
      if (!a || !b) throw new Error("dragAbove: row not visible");
      const { mouse } = this.page;
      await mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await mouse.down();
      await mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 6, { steps: 3 }); // cross the threshold
      await mouse.move(b.x + 40, b.y + 3, { steps: 10 });
      await expect(this.row(above)).toHaveClass(/drop-before/);
      await mouse.up();
    });
  }

  /** Close the pane with Cancel (no discard prompt: nothing here is a draft). */
  close(): Promise<void> {
    return this.step("close", async () => {
      await this.overlay.locator(".editor-buttons button", { hasText: "Cancel" }).click();
      await expect(this.overlay).toBeHidden();
    });
  }

  isOpen(): Promise<boolean> {
    return this.overlay.isVisible();
  }
}
