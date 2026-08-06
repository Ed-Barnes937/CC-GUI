import { expect, type Locator } from "@playwright/test";
import { AppPageObject } from "./AppPageObject.testHelper";
import type { SessionRow } from "../iwft/network/types.testHelper";

// Drives the session sidebar (#sessions). Selects existing ids/classes — the
// sidebar markup is stable and well-named, so no data-test attributes yet.
// State assertions read the fake's snapshot via window.__CC_SIM__ rather than
// verifying which invokes fired (fake, not mock).
export class SidebarPageObject extends AppPageObject {
  private readonly sessions = this.page.locator("#sessions");
  private readonly rows = this.sessions.locator(".session-row");
  private readonly harnessMenu = this.page.locator(".harness-menu");

  /** The row whose title cell matches `title`. */
  row(title: string): Locator {
    return this.rows.filter({ has: this.page.locator(".title", { hasText: title }) });
  }

  /** Visible session titles, top to bottom. */
  titles(): Locator {
    return this.rows.locator(".title");
  }

  rowCount(): Promise<number> {
    return this.rows.count();
  }

  // ----- view mode (GROUP BY segmented control) -----
  /** Label of the currently-active grouping segment (e.g. "Projects"). */
  activeGrouping(): Promise<string> {
    return this.sessions.locator(".group-by-bar .segment.active").innerText();
  }

  /** Drive the GROUP BY segmented control to a side. View mode is GUI-owned
   *  (persisted to localStorage) and re-renders locally — Sections, Projects,
   *  and Status all switch without touching the backend. */
  setGrouping(segment: "Sections" | "Projects" | "Status"): Promise<void> {
    return this.step(`setGrouping: ${segment}`, () =>
      this.sessions
        .locator(".group-by-bar .segment", { hasText: segment })
        .click(),
    );
  }

  // ----- create -----
  /** Open a project's inline create-input, type a title, and commit with Enter. */
  createSession(projectName: string, title: string): Promise<void> {
    return this.step(`createSession: ${title}`, async () => {
      await this.openCreateInput(projectName);
      const input = this.sessions.locator(".create-input input");
      await input.fill(title);
      await input.press("Enter");
    });
  }

  /** Open the create-input, type, then cancel with Esc — leaves no new session. */
  cancelCreateSession(projectName: string, title: string): Promise<void> {
    return this.step("cancelCreateSession", async () => {
      await this.openCreateInput(projectName);
      const input = this.sessions.locator(".create-input input");
      await input.fill(title);
      await input.press("Escape");
      await expect(this.sessions.locator(".create-input")).toHaveCount(0);
    });
  }

  private async openCreateInput(projectName: string): Promise<void> {
    const header = this.sessions
      .locator(".project-header")
      .filter({ hasText: projectName });
    await header.hover();
    await header.getByTitle("New session in this project").click();
    await expect(this.sessions.locator(".create-input input")).toBeVisible();
  }

  // ----- harness picker (inline create-input + create-session dialog) -----

  /** Open a project's inline create-input (no title typed yet). */
  openInlineCreate(projectName: string): Promise<void> {
    return this.step(`openInlineCreate: ${projectName}`, () => this.openCreateInput(projectName));
  }

  /** Open the create-session dialog via the full-width button (section/status
   *  views), then pick the project — leaves the modal open. */
  openCreateDialog(projectName: string): Promise<void> {
    return this.step(`openCreateDialog: ${projectName}`, async () => {
      await this.newSessionButton().click();
      await this.menuItem(projectName).click();
      await expect(this.page.locator(".confirm-overlay")).toBeVisible();
    });
  }

  /** The harness split-button's command label, within `scope`. A Locator so
   *  callers can `toHaveText(...)` and ride out the async initial-selection. */
  harnessCommand(scope = ".create-input-row"): Locator {
    return this.page.locator(`${scope} .harness-command`);
  }

  /** Open the harness dropdown by clicking its button, within `scope`. */
  openHarnessMenu(scope = ".create-input-row"): Promise<void> {
    return this.step("openHarnessMenu", async () => {
      await this.page.locator(`${scope} .harness-button`).click();
      await expect(this.harnessMenu).toBeVisible();
    });
  }

  /** Open the harness dropdown from the keyboard (↓ in the title field). */
  openHarnessMenuViaKey(inputSel = ".create-input input"): Promise<void> {
    return this.step("openHarnessMenuViaKey", async () => {
      await this.page.locator(inputSel).press("ArrowDown");
      await expect(this.harnessMenu).toBeVisible();
    });
  }

  /** Menu entry texts ("Label · command"), top to bottom. */
  harnessMenuItems(): Promise<string[]> {
    return this.harnessMenu.locator(".harness-menu-label").allInnerTexts();
  }

  /** The command marked selected (ticked) in the open menu. */
  tickedHarness(): Promise<string | null> {
    return this.harnessMenu.locator(".harness-menu-item.selected").getAttribute("data-command");
  }

  isHarnessMenuOpen(): Promise<boolean> {
    return this.harnessMenu.isVisible();
  }

  /** Pick a program from the open harness menu. */
  selectHarness(command: string): Promise<void> {
    return this.step(`selectHarness: ${command}`, () =>
      this.harnessMenu.locator(`.harness-menu-item[data-command="${command}"]`).click(),
    );
  }

  /** Full flow: open inline create, pick a harness, type a title, commit. */
  createWithHarness(projectName: string, title: string, command: string): Promise<void> {
    return this.step(`createWithHarness: ${title} [${command}]`, async () => {
      await this.openCreateInput(projectName);
      await this.openHarnessMenu();
      await this.selectHarness(command);
      const input = this.sessions.locator(".create-input input");
      await input.fill(title);
      await input.press("Enter");
    });
  }

  /** Fill and submit the create-session dialog's title field (Enter). */
  submitCreateDialog(title: string): Promise<void> {
    return this.step(`submitCreateDialog: ${title}`, async () => {
      const input = this.page.locator(".confirm-overlay input");
      await input.fill(title);
      await input.press("Enter");
    });
  }

  /** Program recorded on a created session's row (what the backend received). */
  async programOf(title: string): Promise<string | undefined> {
    const sessions = await this.storedSessions();
    return sessions.find((s) => s.title === title)?.program;
  }

  /** Seed the per-project last-used harness memory directly (localStorage) — for
   *  setting up a stale/prior preference the picker should read on open. */
  seedHarnessMemory(repoPath: string, command: string): Promise<void> {
    return this.step(`seedHarnessMemory: ${repoPath}=${command}`, () =>
      this.page.evaluate(
        ([key, cmd]) => localStorage.setItem("cc-harness-last", JSON.stringify({ [key]: cmd })),
        [repoPath, command],
      ),
    );
  }

  // ----- project sub-headers + create paths (section views) -----
  /** A project sub-header inside a section bucket. */
  projectSubheader(name: string): Locator {
    return this.sessions.locator(".project-subheader").filter({ hasText: name });
  }

  /** Project sub-header names, top to bottom (the name span, not the buttons). */
  subheaderNames(): Promise<string[]> {
    return this.page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "#sessions .project-subheader > span:not(.header-buttons)",
        ),
      ].map((s) => (s.textContent ?? "").trim()),
    );
  }

  /** The project sub-header a row currently renders under (nearest preceding
   *  .project-subheader), or null — proves the section sub-grouping. */
  renderedProjectOf(title: string): Promise<string | null> {
    return this.page.evaluate((title) => {
      let project: string | null = null;
      for (const el of document.querySelectorAll<HTMLElement>("#sessions > *")) {
        if (el.classList.contains("project-subheader")) {
          project = el.querySelector("span")?.textContent?.trim() ?? null;
        } else if (
          el.classList.contains("session-row") &&
          el.querySelector(".title")?.textContent?.trim() === title
        ) {
          return project;
        }
      }
      return null;
    }, title);
  }

  /** The full-width "+ New session" button (section views only). */
  newSessionButton(): Locator {
    return this.sessions.locator(".new-session-btn");
  }

  /** Create via a project sub-header's inline "+" (the per-project quick path). */
  createViaSubheader(projectName: string, title: string): Promise<void> {
    return this.step(`createViaSubheader: ${projectName}/${title}`, async () => {
      const header = this.projectSubheader(projectName);
      await header.hover();
      await header.getByTitle("New session in this project").click();
      const input = this.sessions.locator(".create-input input");
      await expect(input).toBeVisible();
      await input.fill(title);
      await input.press("Enter");
    });
  }

  /** Create via the full-width button → pick a project → title prompt (the
   *  universal path that also reaches sessionless projects). */
  createViaButton(projectName: string, title: string): Promise<void> {
    return this.step(`createViaButton: ${projectName}/${title}`, async () => {
      await this.newSessionButton().click();
      await this.menuItem(projectName).click();
      const input = this.page.locator(".confirm-overlay input");
      await expect(input).toBeVisible();
      await input.fill(title);
      await input.press("Enter");
    });
  }

  // ----- add project (sidebar menu → path input with autocomplete) -----
  private readonly pathInput = this.sessions.locator(".path-input input");

  /** Open the sidebar menu and choose "Add project…" — leaves the path input
   *  focused and pre-seeded with `~/`. */
  openAddProject(): Promise<void> {
    return this.step("openAddProject", async () => {
      await this.page.locator("#sidebar-menu").click();
      await this.menuItem("Add project…").click();
      await expect(this.pathInput).toBeVisible();
    });
  }

  /** Replace the path input's value and let the debounced completion settle. */
  typePath(value: string): Promise<void> {
    return this.step(`typePath: ${value}`, async () => {
      await this.pathInput.fill(value);
      // Debounce is 100ms; press a no-op key so `fill` still triggers `input`.
      await this.page.waitForTimeout(150);
    });
  }

  /** The visible autocomplete completion rows, top to bottom. */
  pathCompletions(): Locator {
    return this.sessions.locator(".path-completion");
  }

  /** Press a key in the focused path input (e.g. "Tab", "ArrowDown", "Enter"). */
  pressInPath(key: string): Promise<void> {
    return this.step(`pressInPath: ${key}`, () => this.pathInput.press(key));
  }

  /** The current text in the path input. */
  pathValue(): Promise<string> {
    return this.pathInput.inputValue();
  }

  /** Click the native folder-picker button. */
  clickBrowse(): Promise<void> {
    return this.step("clickBrowse", () => this.sessions.locator(".path-browse").click());
  }

  /** Projects the fake holds (name + repo_path) — assert an add landed. */
  storedProjects(): Promise<{ id: string; name: string; repo_path: string }[]> {
    return this.page.evaluate(
      () =>
        (
          window as unknown as {
            __CC_SIM__: { getProjects(): { id: string; name: string; repo_path: string }[] };
          }
        ).__CC_SIM__.getProjects(),
    );
  }

  // ----- rename (via row context menu → inline input) -----
  rename(title: string, newTitle: string): Promise<void> {
    return this.step(`rename: ${title} → ${newTitle}`, async () => {
      await this.openRowMenu(title);
      await this.menuItem("Rename…").click();
      const input = this.sessions.locator(".rename-input");
      await expect(input).toBeVisible();
      await input.fill(newTitle);
      await input.press("Enter");
    });
  }

  // ----- delete (row action; confirmButton needs two clicks) -----
  deleteViaRowAction(title: string): Promise<void> {
    return this.step(`deleteViaRowAction: ${title}`, async () => {
      const row = this.row(title);
      await row.hover();
      const del = row.getByTitle("Delete session (removes worktree + tmux, keeps the branch)");
      await del.click(); // arms the confirm state
      await del.click(); // confirms
    });
  }

  /** Wake a hibernated session via its row action (the ▶ button, titled
   *  "Wake session" when hibernated). Not a confirm button — one click. */
  wakeViaRowAction(title: string): Promise<void> {
    return this.step(`wakeViaRowAction: ${title}`, async () => {
      const row = this.row(title);
      await row.hover();
      await row.getByTitle("Wake session").click();
    });
  }

  /** Sidebar menu → "Delete merged-PR sessions…" → confirm the dialog. */
  deleteMergedSessions(): Promise<void> {
    return this.step("deleteMergedSessions", async () => {
      await this.page.locator("#sidebar-menu").click();
      await this.menuItem("Delete merged-PR sessions…").click();
      const overlay = this.page.locator(".confirm-overlay");
      await expect(overlay).toBeVisible();
      await overlay.locator(".confirm-buttons button.danger").click();
    });
  }

  // ----- drag a session row onto a section header -----
  /** A section header by its bucket name (section view only). */
  sectionHeader(name: string): Locator {
    return this.sessions
      .locator(".project-header")
      .filter({ has: this.page.locator("span", { hasText: name }) });
  }

  /** Drag a session row onto a section header (pointer-based; see AppPageObject
   *  .pointerDragElement). Releasing over the header commits the re-pin. */
  dragSessionToSection(title: string, sectionName: string): Promise<void> {
    return this.step(`dragSessionToSection: ${title} → ${sectionName}`, () =>
      this.pointerDragElement(this.row(title), this.sectionHeader(sectionName)),
    );
  }

  // ----- context menu -----
  private async openRowMenu(title: string): Promise<void> {
    await this.row(title).click({ button: "right" });
    await expect(this.page.locator(".context-menu")).toBeVisible();
  }

  private menuItem(label: string): Locator {
    return this.page.locator(".context-menu .menu-item", { hasText: label });
  }

  /** Open a row's context menu, left open for further reads (e.g. menuItemText). */
  openContextMenu(title: string): Promise<void> {
    return this.step(`openContextMenu: ${title}`, () => this.openRowMenu(title));
  }

  /** Full text (label + consequence sublabel) of an already-open menu's item —
   *  used to assert Kill/Delete each name what they actually do. */
  menuItemText(label: string): Promise<string> {
    return this.step(`menuItemText: ${label}`, async () => (await this.menuItem(label).textContent()) ?? "");
  }

  // ----- status chip / badges -----
  /** The ⚠ pull-blocked chip on a row in an auto-pull-blocked project
   *  (--danger tone, in the trailing chip cluster). */
  blockedBadge(title: string): Locator {
    return this.row(title).locator(".row-chips .status-chip.tone-danger");
  }

  /** The ✎ pending-comments chip on a row (--info tone, trailing cluster). */
  commentBadge(title: string): Locator {
    return this.row(title).locator(".row-chips .status-chip.tone-info");
  }

  /** A row's liveness status chip (shape + colour + word). It sits on the
   *  sub-line; the leading dot on the top line carries the same colour. */
  statusChip(title: string): Locator {
    return this.row(title).locator(".row-sub > .status-chip");
  }

  /** The word on a row's status chip (e.g. "Running" / "Done" / "Hibernated"). */
  statusLabel(title: string): Promise<string> {
    return this.statusChip(title).locator(".chip-label").innerText();
  }

  // ----- event push (drives the backend's sessions-updated path) -----
  /** Push a snapshot through the real listen() path, exactly as the backend would. */
  pushSnapshot(snapshot: unknown): Promise<void> {
    return this.step("pushSnapshot", () =>
      this.page.evaluate(
        (snap) =>
          (window as unknown as { __CC_SIM__: { pushSnapshot(s: unknown): Promise<void> } })
            .__CC_SIM__.pushSnapshot(snap),
        snapshot,
      ),
    );
  }

  // ----- state-based assertion source (the fake's live snapshot) -----
  storedSessions(): Promise<SessionRow[]> {
    return this.page.evaluate(
      () =>
        (window as unknown as { __CC_SIM__: { getSessions(): SessionRow[] } })
          .__CC_SIM__.getSessions(),
    );
  }

  storedViewMode(): Promise<string> {
    return this.page.evaluate(
      () =>
        (window as unknown as { __CC_SIM__: { getViewMode(): string } })
          .__CC_SIM__.getViewMode(),
    );
  }

  /** The fake's section buckets — assert a session's placement after a move. */
  storedSectionBuckets(): Promise<{ name: string; session_ids: string[] }[] | null> {
    return this.page.evaluate(
      () =>
        (
          window as unknown as {
            __CC_SIM__: { getSectionBuckets(): { name: string; session_ids: string[] }[] | null };
          }
        ).__CC_SIM__.getSectionBuckets(),
    );
  }

  /** The section header a row currently renders under in the DOM (the nearest
   *  preceding header), or null if not found — proves the post-move re-render. */
  renderedSectionOf(title: string): Promise<string | null> {
    return this.page.evaluate((title) => {
      let section: string | null = null;
      for (const el of document.querySelectorAll<HTMLElement>("#sessions > *")) {
        if (el.classList.contains("project-header")) {
          section = el.querySelector("span")?.textContent?.replace(/^[▾▸]\s*/, "").trim() ?? null;
        } else if (
          el.classList.contains("session-row") &&
          el.querySelector(".title")?.textContent?.trim() === title
        ) {
          return section;
        }
      }
      return null;
    }, title);
  }

  /** The tier header a row renders under in the Status grouping ("Needs you" /
   *  "Active" / "Parked") — tier headers reuse .project-header, so this is the
   *  same nearest-preceding-header walk as renderedSectionOf. */
  renderedTierOf(title: string): Promise<string | null> {
    return this.renderedSectionOf(title);
  }

  /** Section moves the frontend dispatched — empty after a no-op drop. */
  storedSectionMoves(): Promise<{ id: string; section: string | null }[]> {
    return this.page.evaluate(
      () =>
        (
          window as unknown as {
            __CC_SIM__: { getSectionMoves(): { id: string; section: string | null }[] };
          }
        ).__CC_SIM__.getSectionMoves(),
    );
  }
}
