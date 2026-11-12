import { test, expect } from "../../support/fixture.testHelper";
import { SESSION_ID, makeSession, makeSnapshot } from "../../network/seed.testHelper";

// Default seed's session attaches under this tmux name (see makeSession).
const TMUX = `cc-${SESSION_ID}`;

// Pointer-based drag from one viewport point to another. Native HTML5 DnD is
// disabled (Tauri's OS drag-drop handler swallows it — see main.ts `draggable`),
// so tab drags are driven by real pointer events: press, cross the 4px
// threshold, move to the target, release.
async function pointerDrag(
  page: import("@playwright/test").Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test("attaching opens a tab and streamed PTY bytes render", async ({ terminal }) => {
  await terminal.attach("fix login bug");

  await expect(terminal.tabLabels()).toHaveText(["fix login bug"]);
  expect(await terminal.placeholderVisible()).toBe(false);

  await terminal.pushText(TMUX, "hello-term");
  await terminal.expectScreenContains("hello-term");
});

test("opening a shell tags its tab with the ❯ Shell chip, not a status dot", async ({ terminal }) => {
  await terminal.openShell("fix login bug");

  // The chip carries the "Shell" word; the tab label is the bare session name.
  await expect(terminal.shellTabChipLabel()).toHaveText("Shell");
  await expect(terminal.tabLabels()).toHaveText(["fix login bug"]);
});

test("Cmd+W closes the active terminal tab", async ({ terminal }) => {
  await terminal.attach("fix login bug");
  await terminal.closeWithCmdW();

  expect(await terminal.tabCount()).toBe(0);
  expect(await terminal.placeholderVisible()).toBe(true);
});

test("the tab close button closes the tab", async ({ terminal }) => {
  await terminal.attach("fix login bug");
  await terminal.closeActiveTabButton();

  expect(await terminal.tabCount()).toBe(0);
});

test("a PTY end auto-restarts and re-attaches a fresh tab", async ({ terminal, page }) => {
  await terminal.attach("fix login bug");
  await terminal.emitExit(TMUX, true); // program exited → restart_fresh + re-attach

  // The re-attach rebuilds a live tab: still one tab, no longer marked dead.
  const tab = page.locator("#tabs .tab");
  await expect(tab).toHaveCount(1);
  await expect(tab).not.toHaveClass(/dead/);
});

test("selecting text copies it to the clipboard and clears the highlight", async ({
  terminal,
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await terminal.attach("fix login bug");
  await terminal.pushText(TMUX, "copyme123");
  await terminal.expectScreenContains("copyme123");

  // Drag across the first row to make a selection, as a user would.
  const screen = page.locator("#terminals .term-container.active .xterm-screen");
  const box = (await screen.boundingBox())!;
  const y = box.y + 6; // first row
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, y, { steps: 12 });
  await page.mouse.up();

  // Finishing the selection copies it (no Cmd+C) and clears the highlight.
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("copyme");
  await expect(page.locator(".xterm-selection div")).toHaveCount(0);
});

test("copy-on-select captures the cell under the release, not just the last mousemove", async ({
  terminal,
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await terminal.attach("fix login bug");
  await terminal.pushText(TMUX, "copyme123");
  await terminal.expectScreenContains("copyme123");

  const screen = page.locator("#terminals .term-container.active .xterm-screen");
  const box = (await screen.boundingBox())!;
  const y = box.y + 6;

  // Drag that stops SHORT of the text's end, then release further right — as a
  // fast real drag does, where coalesced mousemoves lag the release point.
  // xterm ignores the mouseup coordinates, so without our replayed mousemove
  // the trailing characters would be dropped from the copy.
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, y, { steps: 8 });
  await page.evaluate(
    ([sx, sy]) => {
      document
        .querySelector("#terminals .term-container.active .xterm-screen")!
        .dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, clientX: sx, clientY: sy, button: 0 }),
        );
    },
    [box.x + 120, y] as const,
  );

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("copyme123");
});

test("Cmd+Click opens a URL externally; a plain click does not", async ({ terminal, page }) => {
  await terminal.attach("fix login bug");
  await terminal.pushText(TMUX, "https://example.com/foo");
  await terminal.expectScreenContains("example.com");

  const screen = page.locator("#terminals .term-container.active .xterm-screen");
  const box = (await screen.boundingBox())!;
  const x = box.x + 40; // ~6 cells in → inside the URL on row 0
  const y = box.y + 6;

  // A plain click places the cursor; it must not open anything.
  await page.mouse.click(x, y);
  expect(await page.evaluate(() => window.__CC_SIM__.getOpenedUrls())).toEqual([]);

  // Cmd+Click routes the link through open_external.
  await page.keyboard.down("Meta");
  await page.mouse.click(x, y);
  await page.keyboard.up("Meta");
  await expect
    .poll(() => page.evaluate(() => window.__CC_SIM__.getOpenedUrls()))
    .toContain("https://example.com/foo");
});

test("Opt+arrows send the bytes xterm 5 sent for the platform", async ({ terminal, page }) => {
  await terminal.attach("fix login bug");
  await terminal.pressInTerminal("Alt+ArrowLeft");
  await terminal.pressInTerminal("Alt+ArrowRight");
  await terminal.pressInTerminal("Alt+ArrowUp");
  await terminal.pressInTerminal("Alt+ArrowDown");

  // macOS: readline's word back / forward (ESC b / ESC f), and Up/Down left as
  // the raw Alt arrows. Elsewhere all four become the Ctrl+arrow sequences. CI
  // runs this on Linux, so derive the bytes from the platform.
  const isMac = await page.evaluate(() => navigator.platform.toLowerCase().includes("mac"));
  const expected = isMac
    ? ["\x1bb", "\x1bf", "\x1b[1;3A", "\x1b[1;3B"]
    : ["\x1b[1;5D", "\x1b[1;5C", "\x1b[1;5A", "\x1b[1;5B"];
  await expect.poll(() => terminal.ptyWrites(TMUX)).toEqual(expected);
});

test.describe("tab reorder", () => {
  test.use({
    seed: {
      snapshot: makeSnapshot({
        groups: [
          {
            id: "proj-1",
            name: "acme",
            repo_path: "/repos/acme",
            pull_blocked: null,
            sessions: [
              makeSession({ id: "s-a", title: "alpha", tmux_session_name: "cc-s-a" }),
              makeSession({ id: "s-b", title: "beta", tmux_session_name: "cc-s-b" }),
              makeSession({ id: "s-c", title: "gamma", tmux_session_name: "cc-s-c" }),
            ],
          },
        ],
      }),
      reviews: {},
      keybindings: {},
      config: {},
    },
  });

  test("dragging a tab reorders the strip and index navigation", async ({ sidebar, page }) => {
    void sidebar; // boots the app against the 3-session seed
    const attach = async (title: string, expectCount: number) => {
      await page
        .locator(".session-row")
        .filter({ has: page.locator(".title", { hasText: title }) })
        .locator(".row-main")
        .click();
      await expect(page.locator("#tabs .tab")).toHaveCount(expectCount);
    };
    await attach("alpha", 1);
    await attach("beta", 2);
    await attach("gamma", 3);
    await expect(page.locator("#tabs .tab .tab-label")).toHaveText(["alpha", "beta", "gamma"]);

    // Drag tab 0 (alpha) past the last tab: dropping past a tab's midpoint lands
    // before the trailing "+" button, so alpha moves to the end.
    const firstBox = await page.locator("#tabs .tab").nth(0).boundingBox();
    const lastBox = await page.locator("#tabs .tab").nth(2).boundingBox();
    if (!firstBox || !lastBox) throw new Error("tabs not visible");
    await pointerDrag(
      page,
      { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 },
      { x: lastBox.x + lastBox.width - 2, y: lastBox.y + lastBox.height / 2 },
    );
    await expect(page.locator("#tabs .tab .tab-label")).toHaveText(["beta", "gamma", "alpha"]);

    // Index navigation follows the new order: Cmd+1 activates the first tab.
    await page.keyboard.press("Meta+1");
    await expect(page.locator("#tabs .tab.active .tab-label")).toHaveText("beta");
  });
});

test.describe("split panes", () => {
  test.use({
    seed: {
      snapshot: makeSnapshot({
        groups: [
          {
            id: "proj-1",
            name: "acme",
            repo_path: "/repos/acme",
            pull_blocked: null,
            sessions: [
              makeSession({ id: "s-a", title: "alpha", tmux_session_name: "cc-s-a" }),
              makeSession({ id: "s-b", title: "beta", tmux_session_name: "cc-s-b" }),
              makeSession({ id: "s-c", title: "gamma", tmux_session_name: "cc-s-c" }),
            ],
          },
        ],
      }),
      reviews: {},
      keybindings: {},
      config: {},
    },
  });

  // Attach a session by clicking its row (the shared-tab-bar list).
  const attach = (page: import("@playwright/test").Page, title: string, count: number) =>
    page
      .locator(".session-row")
      .filter({ has: page.locator(".title", { hasText: title }) })
      .locator(".row-main")
      .click()
      .then(() => expect(page.locator("#tabs .tab")).toHaveCount(count));

  // Drag the tab for `tmux` into a quadrant of #terminals ("TL"|"TR"|"BL"|"BR"),
  // releasing there to seed/extend a split (pointer-based; see pointerDrag).
  const dropIntoQuadrant = async (page: import("@playwright/test").Page, tmux: string, q: string) => {
    const tabBox = await page.locator(`#tabs .tab[data-term="${tmux}"]`).boundingBox();
    const termBox = await page.locator("#terminals").boundingBox();
    if (!tabBox || !termBox) throw new Error(`drag source/target missing: ${tmux}`);
    const fx = q[1] === "L" ? 0.25 : 0.75;
    const fy = q[0] === "T" ? 0.25 : 0.75;
    await pointerDrag(
      page,
      { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 },
      { x: termBox.x + termBox.width * fx, y: termBox.y + termBox.height * fy },
    );
  };

  test("dragging a tab into a corner creates a two-pane vertical split", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2); // beta is now the active single terminal

    // Drag the non-active tab (alpha) into the top-right corner. From single
    // mode this seeds a vertical split: the on-screen session (beta) takes the
    // opposite column (TL), alpha lands in TR.
    await dropIntoQuadrant(page, "cc-s-a", "TR");

    await expect(page.locator("#terminals")).toHaveClass(/split/);
    await expect(page.locator("#terminals .pane")).toHaveCount(2);
    await expect(page.locator('#terminals .pane[data-slot="TL"]')).toHaveAttribute("data-term", "cc-s-b");
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-a");
    // Both on-screen tabs are tagged with their quadrant colour.
    await expect(page.locator("#tabs .tab.in-pane")).toHaveCount(2);
  });

  test("building a third pane subdivides a column (columns-of-stacks)", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);
    await dropIntoQuadrant(page, "cc-s-a", "TR"); // TL=beta, TR=alpha (focused TR)
    await attach(page, "gamma", 3); // loads into the focused pane → TR=gamma, alpha parked
    await dropIntoQuadrant(page, "cc-s-a", "BR"); // drag parked alpha into BR: right column splits

    await expect(page.locator("#terminals .pane")).toHaveCount(3);
    // Left column: one pane (beta) full height. Right column: two stacked panes.
    const cols = page.locator("#terminals .split-col");
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0).locator(".pane")).toHaveCount(1);
    await expect(cols.nth(1).locator(".pane")).toHaveCount(2);
  });

  test("loading a session into the focused pane replaces it (displaced stays alive)", async ({
    sidebar,
    page,
  }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);
    await dropIntoQuadrant(page, "cc-s-a", "TR"); // TL=beta, TR=alpha (focused TR)
    await attach(page, "gamma", 3); // gamma replaces alpha in the focused pane

    await expect(page.locator("#terminals .pane")).toHaveCount(2);
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-c");
    // alpha is displaced but still open: its tab and its (parked) terminal survive.
    await expect(page.locator("#tabs .tab")).toHaveCount(3);
    await expect(page.locator('#terminals .pane[data-term="cc-s-a"]')).toHaveCount(0);
    await expect(page.locator("#terminals .term-container")).toHaveCount(3);
  });

  test("removing a pane via its × collapses back to a single terminal", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);
    await dropIntoQuadrant(page, "cc-s-a", "TR");
    await expect(page.locator("#terminals")).toHaveClass(/split/);

    await page.locator('#terminals .pane[data-slot="TR"] .pane-close').click();

    // Down to one pane → leaves split; both sessions still open as tabs.
    await expect(page.locator("#terminals")).not.toHaveClass(/split/);
    await expect(page.locator("#terminals .pane")).toHaveCount(0);
    await expect(page.locator("#tabs .tab")).toHaveCount(2);
  });

  test("the drop-zone overlay previews the hovered quadrant while dragging", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);

    const tabBox = await page.locator('#tabs .tab[data-term="cc-s-a"]').boundingBox();
    const termBox = await page.locator("#terminals").boundingBox();
    if (!tabBox || !termBox) throw new Error("drag source/target missing");
    // Press the tab, cross the threshold, then hover the TR quadrant (don't drop).
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(tabBox.x + tabBox.width / 2 + 6, tabBox.y + tabBox.height / 2, { steps: 3 });
    await page.mouse.move(termBox.x + termBox.width * 0.75, termBox.y + termBox.height * 0.25, { steps: 10 });

    await expect(page.locator("#split-overlay")).toHaveClass(/show/);
    await expect(page.locator("#split-overlay .dz.tr")).toHaveClass(/hot/);
    await expect(page.locator("#split-overlay .dz.tl")).not.toHaveClass(/hot/);

    // Cancel with Esc so no split commits, then release the button.
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });

  test("dragging one visible pane onto the other swaps them (no collapse)", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);
    await dropIntoQuadrant(page, "cc-s-a", "TR"); // TL=beta, TR=alpha
    await expect(page.locator('#terminals .pane[data-slot="TL"]')).toHaveAttribute("data-term", "cc-s-b");
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-a");

    // Drag the visible TR pane (alpha) onto the visible TL pane (beta): they swap.
    await dropIntoQuadrant(page, "cc-s-a", "TL");

    await expect(page.locator("#terminals")).toHaveClass(/split/);
    await expect(page.locator("#terminals .pane")).toHaveCount(2);
    await expect(page.locator('#terminals .pane[data-slot="TL"]')).toHaveAttribute("data-term", "cc-s-a");
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-b");
  });

  test("a parked session's auto-restart does not hijack the focused pane", async ({ sidebar, page }) => {
    void sidebar;
    await attach(page, "alpha", 1);
    await attach(page, "beta", 2);
    await dropIntoQuadrant(page, "cc-s-a", "TR"); // TL=beta, TR=alpha (focused TR)
    await attach(page, "gamma", 3); // gamma replaces alpha in the focused pane; alpha parked
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-c");

    // Parked alpha's program exits → auto-restarts in place. It must NOT be
    // injected into the focused pane (that only happens on a user attach).
    await page.evaluate(() =>
      (window as unknown as { __CC_SIM__: { emitPtyExit(n: string, e: boolean): Promise<void> } }).__CC_SIM__.emitPtyExit(
        "cc-s-a",
        true,
      ),
    );

    // Focused pane still shows gamma; still two panes; alpha stays parked + alive.
    await expect(page.locator('#terminals .pane[data-slot="TR"]')).toHaveAttribute("data-term", "cc-s-c");
    await expect(page.locator("#terminals .pane")).toHaveCount(2);
    await expect(page.locator('#terminals .pane[data-term="cc-s-a"]')).toHaveCount(0);
    await expect(page.locator('#tabs .tab[data-term="cc-s-a"]')).not.toHaveClass(/dead/);
  });
});
