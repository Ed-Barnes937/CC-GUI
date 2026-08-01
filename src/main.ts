import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { openReview, closeReview } from "./review";
import { openExplorer, closeExplorer, isExplorerOpen } from "./fileExplorer";
// PROTOTYPE: markdown viewer — delete this import with markdownViewerPrototype.ts
import { openMarkdownViewer, closeMarkdownViewer, isMarkdownViewerOpen } from "./markdownViewerPrototype";
import { toast, confirmDialog, promptDialog, deleteSessionDialog } from "./toast";
import { makeResizable, adjustPanelWidth } from "./resize";
import { showContextMenu, MenuItem } from "./menu";
import { registerPaletteProvider, togglePalette } from "./palette";
import { toggleHelp, setHelpKeybindings } from "./help";
import {
  initKeybindings,
  reloadKeybindings,
  loadedBindings,
  formatBinding,
  overlayOpen as keyOverlayOpen,
} from "./keys";
import { openSettings } from "./settings";
import { statusChip, commentsChip, pullBlockedChip, stackChip, shellChip, stateChipInfo, stateTier, STATUS_TIERS, type StatusState, type StatusTier } from "./status";
import { noTextAssist } from "./dom";
import {
  initTheme,
  setMode,
  currentTheme,
  onThemeChange,
  followSystem,
  resolveTheme,
  applyTheme,
  registerCustomThemes,
  validateTheme,
  type Theme,
} from "./theme";
import { openThemeModal } from "./themeModal";
import { createHarnessPicker, createSessionDialog, rememberHarness } from "./harnessPicker";

// Apply the GUI theme (CSS custom properties) before any dynamic content renders,
// then follow the OS appearance via the native Tauri theme event when in System mode.
initTheme();
void getCurrentWindow().onThemeChanged(() => followSystem());

// Dropping OS files onto the window inserts them as `@<path>` references into the
// active session's prompt (mirrors the file explorer's reference insertion).
// Requires `dragDropEnabled: true` in tauri.conf.json.
void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop") return;
  if (!activeTerm) {
    toast("No active session to drop files into", "error");
    return;
  }
  const target = activeTerm;
  const refs = event.payload.paths.map((p) => `@${p} `).join("");
  void invoke("write_pty", { tmuxSession: target, data: refs })
    .then(() => terminals.get(target)?.term.focus())
    .catch((e) => toast(`could not insert reference: ${e}`, "error"));
});

// Warm the bundled terminal font (both weights) before any xterm is created, so
// it measures glyph dimensions against MesloLGS NF rather than the fallback.
void Promise.all([
  document.fonts.load('13px "MesloLGS NF Embedded"'),
  document.fonts.load('bold 13px "MesloLGS NF Embedded"'),
]);

// Load user-authored themes from disk, register the valid ones, and re-apply if a
// custom theme now occupies the active light/dark slot. Runs after initTheme() so
// a built-in (or the cached vars from the no-flash boot script) is already on
// screen — this upgrades to the custom theme without blocking first paint.
async function loadCustomThemes(announce = false): Promise<void> {
  let files: { file: string; content: unknown }[];
  try {
    files = await invoke("list_custom_themes");
  } catch (e) {
    toast(`Failed to load custom themes: ${e}`, "error");
    return;
  }
  const valid: Theme[] = [];
  const errors: string[] = [];
  for (const { file, content } of files) {
    const result = validateTheme(content);
    if ("theme" in result) valid.push(result.theme);
    else errors.push(`${file}: ${result.error}`);
  }
  registerCustomThemes(valid);
  const next = resolveTheme();
  if (next.id !== currentTheme().id) applyTheme(next);
  if (errors.length) {
    toast(`Skipped ${errors.length} invalid theme file(s) — ${errors.join("; ")}`, "error");
  }
  // announce only on an explicit reload — the boot call stays silent.
  if (announce) toast(`Loaded ${valid.length} custom theme(s)`);
}
void loadCustomThemes();

// Write the active theme out as an editable starting template, then register it
// and reveal the folder. The id/label are fresh so the file never collides with
// its source (a built-in's id would be rejected on reload).
async function exportThemeTemplate(): Promise<void> {
  const name = await promptDialog(
    "Name for the new theme (saved as a .json in the themes folder):",
    "my-theme",
  );
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-theme";
  const t = currentTheme();
  const template = {
    id: slug,
    label: name,
    appearance: t.appearance,
    cssVars: t.cssVars,
    terminal: t.terminal,
    shiki: t.shiki,
  };
  try {
    const path = await invoke<string>("save_custom_theme", { name: slug, theme: template });
    await loadCustomThemes(); // register it now so it's pickable immediately
    toast(`Saved ${path} — edit it, then pick it from the palette`);
    void invoke("open_themes_dir").catch(() => {});
  } catch (e) {
    toast(`Export failed: ${e}`, "error");
  }
}

type SessionRow = {
  id: string;
  title: string;
  branch: string;
  status: string;
  program: string;
  agent_state: string;
  tmux_session_name: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: "open" | "closed" | "merged" | null;
  pr_draft: boolean;
  pr_labels: string[];
  review_decision: string | null;
  has_pending_comments: boolean;
  unread: boolean;
  hibernated: boolean;
  stacked_child: boolean;
  project_id: string;
  project_name: string;
  current_section: string | null;
};

type ProjectGroup = {
  id: string;
  name: string;
  repo_path: string;
  pull_blocked: string | null;
  sessions: SessionRow[];
};

type SectionBucket = { name: string; session_ids: string[] };

type Snapshot = {
  groups: ProjectGroup[];
  view_mode: string;
  sections: SectionBucket[] | null;
  section_names: string[];
  commander: { enabled: boolean; running: boolean };
};

type SessionDetail = {
  id: string;
  title: string;
  branch: string;
  status: string;
  program: string;
  project_name: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string;
  pr_draft: boolean;
  created_at: string;
  agent_state: string;
  diff_stat: string | null;
};

const sessionsEl = document.querySelector<HTMLDivElement>("#sessions")!;
// Native listbox navigation when the sidebar list itself holds focus: bare
// ↑/↓ walk the cursor and Enter opens, matching the ARIA listbox pattern for
// keyboard/AT users. The global Cmd+Opt+↑/↓ chords still work regardless of
// focus; this only adds the standard interaction when #sessions is focused.
sessionsEl.addEventListener("keydown", (e) => {
  if (e.metaKey || e.altKey || e.ctrlKey) return; // don't shadow the chords
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cycleSession(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cycleSession(-1);
  } else if (e.key === "Enter" && selectedId) {
    e.preventDefault();
    const s = findSession(selectedId);
    if (s) void openTerminal(s);
  }
});
const tabsEl = document.querySelector<HTMLDivElement>("#tabs")!;
const terminalsEl = document.querySelector<HTMLDivElement>("#terminals")!;
const placeholderEl = document.querySelector<HTMLDivElement>("#placeholder")!;
const detailEl = document.querySelector<HTMLElement>("#detail")!;
const detailTitleEl = document.querySelector<HTMLSpanElement>("#detail-title")!;
const detailMetaEl = document.querySelector<HTMLDListElement>("#detail-meta")!;
const detailChangesEl = document.querySelector<HTMLDivElement>("#detail-changes-label")!;
const detailDiffstatEl = document.querySelector<HTMLDivElement>("#detail-diffstat")!;
const detailSummaryEl = document.querySelector<HTMLDivElement>("#detail-summary")!;
const detailTagsEl = document.querySelector<HTMLDivElement>("#detail-tags")!;
const summaryGenEl = document.querySelector<HTMLButtonElement>("#summary-gen")!;
const detailReviewEl = document.querySelector<HTMLButtonElement>("#detail-review")!;
const detailPrEl = document.querySelector<HTMLButtonElement>("#detail-pr")!;

// ---------------------------------------------------------------- terminals

type TermEntry = {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  surface: HTMLDivElement; // inner element xterm renders into
  tab: HTMLDivElement;
  glyph: HTMLSpanElement;
  title: string;
  dead: boolean;
};

const terminals = new Map<string, TermEntry>(); // keyed by tmux session name
let activeTerm: string | null = null;

// ------------------------------------------------------------- split panes
// Console view can show up to 4 terminals at once, dragged into quadrant drop
// zones. Layout is "columns-of-stacks": up to two columns, each an independent
// stack of up to two rows (left = [TL, BL], right = [TR, BR]). Empty columns /
// rows collapse. This avoids the unresolvable L-shapes a free 2×2 grid produces.
// One PTY per tmux session (pty.rs) ⇒ a session lives in exactly one pane;
// dropping onto an occupied slot REPLACES (the displaced session parks as a
// hidden direct child of #terminals, still alive). Split is active when
// `panes.size >= 2`; single-pane keeps the classic `activateTerminal` path.
type Slot = "TL" | "TR" | "BL" | "BR";
const panes = new Map<Slot, string>(); // slot -> tmux session name (split mode)
let focusedSlot: Slot | null = null;

// Per-quadrant accent colour: reused for the pane ring, the drop-zone preview,
// and the matching tab top-border so it's obvious which tab is on screen where.
const SLOT_COLOR: Record<Slot, string> = {
  TL: "var(--accent)", // blue
  TR: "var(--attention)", // peach/orange
  BL: "var(--success)", // green
  BR: "var(--info)", // mauve
};

// Split ratios (grow fractions), persisted; slot→session mapping is NOT.
function loadRatio(key: string): number {
  const v = Number(localStorage.getItem(key));
  return v >= 0.15 && v <= 0.85 ? v : 0.5;
}
let colRatio = loadRatio("cc-split-col"); // left column width fraction
let leftRowRatio = loadRatio("cc-split-rows-l"); // TL height within left column
let rightRowRatio = loadRatio("cc-split-rows-r"); // TR height within right column

const splitActive = (): boolean => panes.size >= 2;

/** Toggle the "select a session" placeholder for the current terminal count,
 *  and refresh the onboarding hero alongside it — the hero also gates on
 *  whether a terminal is attached (not just on project count), so attaching
 *  one (e.g. via the hero's own commander CTA) yields the hero instead of
 *  leaving it rendered on top of the newly attached terminal. */
function updatePlaceholder(): void {
  placeholderEl.style.display = terminals.size ? "none" : "flex";
  renderOnboarding();
}

// Re-theme every live terminal when the GUI theme changes. The DOM renderer
// repaints automatically on an options.theme assignment.
onThemeChange((theme) => {
  for (const entry of terminals.values()) {
    entry.term.options.theme = theme.terminal;
  }
});

function activateTerminal(name: string): void {
  // Split mode: focus the pane already showing this session, else load it into
  // the focused pane (replacing whatever was there — the displaced session
  // parks but stays alive as a tab).
  if (splitActive()) {
    const slot = [...panes].find(([, n]) => n === name)?.[0];
    if (slot) focusPane(slot);
    else setPane(focusedSlot ?? firstSlot(), name);
    return;
  }
  activeTerm = name;
  for (const [key, entry] of terminals) {
    const active = key === name;
    entry.container.classList.toggle("active", active);
    entry.tab.classList.toggle("active", active);
  }
  updatePlaceholder();
  const entry = terminals.get(name);
  if (entry) {
    // In board mode the terminal lives in the dock; dock+fit there (fitting in
    // the hidden #terminals would measure a zero-size element). Otherwise fit
    // in place.
    if (layout === "board") {
      dockActiveTerminal();
    } else {
      entry.fit.fit();
      void invoke("resize_pty", {
        tmuxSession: name,
        rows: entry.term.rows,
        cols: entry.term.cols,
      });
      entry.term.focus();
    }
  } else if (layout === "board") {
    // The active terminal was just removed: refresh the dock to its placeholder.
    updateDockHeader();
  }
  renderSidebar();
}

function closeTerminal(name: string): void {
  const entry = terminals.get(name);
  if (!entry) return;
  void invoke("detach", { tmuxSession: name });
  entry.term.dispose();
  entry.container.remove(); // drops it from a pane cell or from #terminals
  entry.tab.remove();
  terminals.delete(name);

  // Split bookkeeping: vacate the slot, then re-render or fall back to single.
  const wasSplit = splitActive();
  const slot = [...panes].find(([, n]) => n === name)?.[0];
  if (slot) panes.delete(slot);
  if (splitActive()) {
    if (focusedSlot === slot) focusedSlot = firstSlot();
    renderPanes();
    updatePlaceholder();
    renderSidebar();
    return;
  }
  if (wasSplit) {
    // Dropped below two panes: leave split, keeping the remaining session.
    exitSplit([...panes.values()][0] ?? terminals.keys().next().value ?? null);
    updatePlaceholder();
    renderSidebar();
    return;
  }

  if (activeTerm === name) {
    activeTerm = terminals.keys().next().value ?? null;
    if (activeTerm) activateTerminal(activeTerm);
    else if (layout === "board") updateDockHeader(); // no terminal left → dock placeholder
  }
  updatePlaceholder();
  renderSidebar();
}

// --------------------------------------------------- pointer drag-and-drop
// HTML5 native drag-and-drop is unavailable: Tauri's OS drag-drop handler
// (enabled for file drops in tauri.conf.json) swallows the webview's HTML5
// drag events. So tab reorder, sidebar row → section, board card → column, and
// board column reorder are all driven by pointer events instead.
//
// A drag begins only once the pointer moves past a small threshold, so plain
// clicks and context-menus on the handle still work. During a drag the handle
// captures the pointer and each flow hit-tests its own drop targets (by
// elementFromPoint or coordinates) in `onMove`/`onDrop`. `onDrop` runs only on
// release over a target; Esc or pointercancel ends the drag with `onEnd` alone,
// leaving state untouched — mirroring the old `drop`-vs-`dragend` split.
interface DragSession {
  onMove(x: number, y: number): void;
  onDrop(x: number, y: number): void;
  onEnd(): void;
}

function draggable(handle: HTMLElement, begin: () => DragSession | null): void {
  handle.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return; // left button only; right-click = context menu
    const sx = down.clientX;
    const sy = down.clientY;
    let sess: DragSession | null = null;

    const move = (e: PointerEvent) => {
      if (!sess) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return; // below threshold: still a click
        sess = begin();
        if (!sess) return teardown();
        handle.setPointerCapture(down.pointerId);
        document.body.style.userSelect = "none";
      }
      e.preventDefault(); // suppress text selection / scroll while dragging
      sess.onMove(e.clientX, e.clientY);
    };
    const end = (drop: PointerEvent | null) => {
      if (sess) {
        if (drop) sess.onDrop(drop.clientX, drop.clientY);
        sess.onEnd();
        document.body.style.userSelect = "";
        if (drop) suppressNextClick(handle); // eat the click synthesized by this pointerup
      }
      teardown();
    };
    const onUp = (e: PointerEvent) => end(e);
    const onCancel = () => end(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sess) {
        e.preventDefault();
        e.stopPropagation();
        end(null);
      }
    };
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      try {
        handle.releasePointerCapture(down.pointerId);
      } catch {
        // never captured (drag never crossed the threshold) — nothing to release
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
}

/** Swallow the click synthesized by a drag-ending pointerup, so a drag that
 *  starts on a clickable handle (tab, card, row) doesn't also fire its click. */
function suppressNextClick(handle: HTMLElement): void {
  const eat = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    handle.removeEventListener("click", eat, true);
  };
  handle.addEventListener("click", eat, true);
  // If no click follows (release off the handle), drop the listener next tick so
  // it can't eat an unrelated later click.
  setTimeout(() => handle.removeEventListener("click", eat, true), 0);
}

/** The tab to insert the dragged tab before, given the pointer's x (null = end). */
function tabBeforeX(x: number): HTMLDivElement | null {
  const tabs = [...tabsEl.querySelectorAll<HTMLDivElement>(".tab:not(.dragging)")];
  for (const tab of tabs) {
    const box = tab.getBoundingClientRect();
    if (x < box.left + box.width / 2) return tab;
  }
  return null;
}

/** Show the insertion marker before `target` (or after the last tab when null). */
function showDropMarker(target: HTMLDivElement | null): void {
  clearDropMarker();
  if (target) {
    target.classList.add("drop-before");
  } else {
    const tabs = tabsEl.querySelectorAll<HTMLDivElement>(".tab:not(.dragging)");
    tabs[tabs.length - 1]?.classList.add("drop-after");
  }
}

function clearDropMarker(): void {
  for (const t of tabsEl.querySelectorAll(".drop-before, .drop-after")) {
    t.classList.remove("drop-before", "drop-after");
  }
}

/** Rebuild the Map's iteration order from the current tab DOM order. */
function syncTermOrderFromDom(): void {
  const order = [...tabsEl.querySelectorAll<HTMLDivElement>(".tab")]
    .map((t) => t.dataset.term)
    .filter((n): n is string => !!n && terminals.has(n));
  if (order.length !== terminals.size) return;
  const entries = order.map((n) => [n, terminals.get(n)!] as const);
  terminals.clear();
  for (const [n, e] of entries) terminals.set(n, e);
}

// "+" new-terminal button — pinned to the end of the strip. It has no
// `dataset.term`, so the drag-reorder helpers (tabBeforeX queries `.tab`,
// syncTermOrderFromDom filters by dataset.term) ignore it; the drop handler
// keeps it last by inserting dragged tabs before it.
const tabNewBtn = document.createElement("button");
tabNewBtn.className = "tab-new";
tabNewBtn.textContent = "+";
tabNewBtn.title = "New session";
tabNewBtn.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));
tabsEl.appendChild(tabNewBtn);

async function openTerminal(session: SessionRow): Promise<void> {
  // A deliberate attach resets the crash-loop guard for this session.
  consecutiveEnds.delete(session.tmux_session_name);
  // Recreates the tmux session first if the session is stopped or its pane
  // died, matching the TUI's attach behaviour.
  await attachTerminal(session.tmux_session_name, session.title, () =>
    invoke("prepare_attach", { id: session.id }),
  );
}

/** Open the per-worktree shell terminal for a session. */
async function openShell(session: SessionRow): Promise<void> {
  let name: string;
  try {
    name = await invoke<string>("prepare_shell", { id: session.id });
  } catch (e) {
    toast(`shell failed: ${e}`, "error");
    return;
  }
  // The tab carries a "❯ Shell" chip (name ends "-sh"), so the title stays the
  // bare session name — keeping entry.title consistent across the tab, the
  // split-pane header, and the board dock (all read entry.title).
  await attachTerminal(name, session.title, null);
}

async function openProjectShell(group: ProjectGroup): Promise<void> {
  let name: string;
  try {
    name = await invoke<string>("prepare_project_shell", { id: group.id });
  } catch (e) {
    toast(`project shell failed: ${e}`, "error");
    return;
  }
  await attachTerminal(name, group.name, null); // see openShell re: the bare title
}

/**
 * Attach (or focus) a terminal tab for a tmux session. `prepare` runs before
 * the PTY attach to ensure the tmux session exists (null when the caller
 * already ensured it).
 */
async function attachTerminal(
  name: string,
  title: string,
  prepare: (() => Promise<unknown>) | null,
): Promise<void> {
  const existing = terminals.get(name);
  if (existing && !existing.dead) {
    activateTerminal(name);
    return;
  }
  if (existing) closeTerminal(name); // dead: rebuild from scratch

  // The terminal is a rounded surface that xterm renders into directly; the
  // FitAddon measures the whole container.
  const container = document.createElement("div");
  container.className = "term-container";

  const surface = document.createElement("div");
  surface.className = "term-surface";

  container.append(surface);
  terminalsEl.appendChild(container);

  const term = new Terminal({
    fontFamily: '"MesloLGS NF Embedded", "MesloLGS NF", Menlo, Monaco, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: currentTheme().terminal,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Cmd+Click opens links. xterm underlines URLs on hover; the handler only
  // fires the platform opener when Cmd is held, so a plain click still places
  // the cursor / starts a selection like a native terminal.
  term.loadAddon(
    new WebLinksAddon((e, uri) => {
      if (e.metaKey) void invoke("open_external", { url: uri });
    }),
  );
  // xterm measures glyph dimensions at open(), so the bundled font must be
  // loaded first — otherwise it sizes cells against the fallback and icon
  // glyphs never render. The boot-time preload usually wins this race, but
  // await here to be certain before the first paint.
  await Promise.all([
    document.fonts.load('13px "MesloLGS NF Embedded"'),
    document.fonts.load('bold 13px "MesloLGS NF Embedded"'),
  ]).catch(() => {});
  term.open(surface);

  // Honor OSC 52: programs like Claude's TUI manage their own mouse selection
  // and copy by emitting an OSC 52 clipboard sequence (this is what makes a
  // plain drag-to-copy work inside Claude, no Cmd+C). xterm ignores OSC 52
  // unless this addon is loaded; route it through the Tauri clipboard plugin
  // so the write lands on the native pasteboard from the WKWebView.
  term.loadAddon(
    new ClipboardAddon(undefined, {
      readText: () => readText(),
      writeText: (_sel, text) => writeText(text),
    }),
  );

  // Copy-on-select for plain shells (no app mouse mode): finishing a drag
  // selection copies it to the clipboard and clears the highlight. In an app
  // that grabs the mouse (Claude), xterm makes no selection and this no-ops —
  // OSC 52 above handles that case instead.
  //
  // xterm sets the selection end only from mousemove; its own mouseup handler
  // discards the release coordinates. On a fast release the final mousemove
  // lags the pointer, so the selection (and thus the copy) stops a cell short.
  // This bubble listener runs before xterm's document-level mouseup handler —
  // where it detaches its drag listeners — so replaying the release point as a
  // mousemove extends the selection to where the button actually came up.
  surface.addEventListener("mouseup", (e) => {
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        clientX: e.clientX,
        clientY: e.clientY,
        buttons: 1,
        bubbles: true,
      }),
    );
    const sel = term.getSelection();
    if (!sel) return;
    void writeText(sel).catch((e) =>
      console.error("clipboard write failed", e),
    );
    term.clearSelection();
  });

  term.onData((data) => {
    void invoke("write_pty", { tmuxSession: name, data });
  });

  // macOS line-editing shortcuts. Native terminals (Terminal.app, iTerm2) map
  // these Cmd combos to readline control bytes; xterm.js passes Cmd through
  // untouched, so we translate them ourselves. Bare Cmd only — combos with
  // other modifiers (e.g. Cmd+W) must fall through to their own handlers.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Ctrl+\ — switch to this session's shell, mirroring claude-commander's
    // attach-mode shell toggle (it intercepts the same key while attached).
    // Handled here so it fires while the terminal is focused, where the
    // config-driven keybindings (including select_shell) are suppressed. A
    // no-op on shell/project-shell terminals, whose name matches no session.
    if (e.ctrlKey && e.key === "\\" && !e.metaKey && !e.altKey && !e.shiftKey) {
      const s = groups.flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name);
      if (s) {
        e.preventDefault();
        void openShell(s);
        return false;
      }
    }
    // Shift+Enter: insert a newline instead of submitting. xterm.js sends a
    // plain CR (\r) for Enter regardless of Shift, which submits. Send LF (\n,
    // i.e. Ctrl+J) instead — the TUI's "insert newline" byte; in a plain shell
    // readline treats it the same as Enter, so it does no harm there.
    if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void invoke("write_pty", { tmuxSession: name, data: "\n" });
      return false;
    }
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return true;
    }
    const byte =
      e.key === "Backspace" ? "\x15" : e.key === "ArrowLeft" ? "\x01" : e.key === "ArrowRight" ? "\x05" : null;
    if (byte === null) return true;
    e.preventDefault();
    void invoke("write_pty", { tmuxSession: name, data: byte });
    return false;
  });
  term.onResize(({ rows, cols }) => {
    void invoke("resize_pty", { tmuxSession: name, rows, cols });
  });

  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.term = name;
  // Drag a tab to reorder it within the strip, or onto #terminals to open it in
  // a split pane. The move commits on release over a target; an Esc-cancelled
  // drag leaves both the order and the split layout unchanged.
  draggable(tab, () => {
    tab.classList.add("dragging");
    return {
      onMove(x, y) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest("#terminals")) {
          clearDropMarker();
          showSplitOverlay(quadrantAt(x, y));
        } else if (el?.closest("#tabs")) {
          hideSplitOverlay();
          showDropMarker(tabBeforeX(x));
        } else {
          clearDropMarker();
          hideSplitOverlay();
        }
      },
      onDrop(x, y) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest("#terminals")) {
          assignPane(quadrantAt(x, y), name);
        } else if (el?.closest("#tabs")) {
          const before = tabBeforeX(x);
          // Keep the trailing "+" button last: drop "at the end" means before it.
          if (before) tabsEl.insertBefore(tab, before);
          else tabsEl.insertBefore(tab, tabNewBtn);
          syncTermOrderFromDom();
        }
      },
      onEnd() {
        tab.classList.remove("dragging");
        clearDropMarker();
        hideSplitOverlay();
      },
    };
  });
  const glyph = document.createElement("span");
  glyph.className = "tab-glyph dot";
  glyph.hidden = true; // shown once a matching session status is known
  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = title;
  // Shell tabs (tmux name ends "-sh") carry no session status, so the liveness
  // dot stays hidden; mark them with the shared "❯ Shell" chip instead (the
  // title is already the bare name — see openShell).
  const isShell = name.endsWith("-sh");
  const close = document.createElement("button");
  close.className = "tab-close";
  close.textContent = "×";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTerminal(name);
  });
  if (isShell) {
    const shell = shellChip("Shell terminal");
    shell.classList.add("tab-shell");
    tab.append(shell, label, close);
  } else {
    tab.append(glyph, label, close);
  }
  tab.addEventListener("click", () => activateTerminal(name));
  tabsEl.insertBefore(tab, tabNewBtn); // keep the "+" button trailing

  const entry: TermEntry = {
    term,
    fit,
    container,
    surface,
    tab,
    glyph,
    title,
    dead: false,
  };
  terminals.set(name, entry);
  updateTabGlyphs();

  const onData = new Channel<number[]>();
  onData.onmessage = (chunk) => term.write(new Uint8Array(chunk));

  try {
    if (prepare) await prepare();
    await invoke("attach", { tmuxSession: name, onData });
  } catch (e) {
    term.write(`\r\nFailed to attach: ${e}\r\n`);
    entry.dead = true;
  }
  activateTerminal(name);
}

function refitActive(): void {
  if (!activeTerm) return;
  const entry = terminals.get(activeTerm);
  if (!entry) return;
  entry.fit.fit();
  void invoke("resize_pty", {
    tmuxSession: activeTerm,
    rows: entry.term.rows,
    cols: entry.term.cols,
  });
}

// ---------------------------------------------------------------- board dock
// In board mode the active session's terminal lives in the dock at the bottom
// of #board: we MOVE the existing `.term-container` node out of #terminals into
// #board-dock-surface (one PTY — no duplicate). The container is absolutely
// positioned (inset:4px), so it fills whichever positioned parent holds it;
// after any re-parent it must be re-fit once its new parent is laid out. When
// switching back to Console the container returns to #terminals.

// The user can "×" close the dock without killing the PTY: the terminal goes
// back to #terminals and the whole dock panel collapses out of the board so the
// columns fill the space. The PTY stays attached. Cleared by attaching from a
// card or re-entering board mode.
let dockDetached = false;

/** Fill the dock header (session name + branch) from the active terminal's
 *  snapshot row, toggle the placeholder vs. the docked terminal, and collapse
 *  the whole dock panel when the user has closed it with "×". */
function updateDockHeader(): void {
  boardDockEl.classList.toggle("dock-closed", dockDetached);
  const entry = activeTerm && !dockDetached ? terminals.get(activeTerm) : null;
  if (!entry) {
    boardDockNameEl.textContent = "";
    boardDockBranchEl.textContent = "";
    boardDockPlaceholderEl.style.display = "flex";
    return;
  }
  const s = groups.flatMap((g) => g.sessions).find((x) => x.tmux_session_name === activeTerm);
  boardDockNameEl.textContent = s ? s.title : entry.title;
  boardDockBranchEl.textContent = s ? s.branch : "";
  boardDockPlaceholderEl.style.display = "none";
}

/** Move the active terminal's container into the dock surface and re-fit. With
 *  no active terminal (or after an explicit detach) the dock shows its
 *  placeholder. Safe to call repeatedly (re-parenting a node into its current
 *  parent is a no-op move). */
function dockActiveTerminal(): void {
  updateDockHeader();
  if (!activeTerm || dockDetached) return;
  const entry = terminals.get(activeTerm);
  if (!entry) return;
  boardDockSurfaceEl.appendChild(entry.container);
  // Mirror activateTerminal: only the active container is shown, and fit must
  // run after the move so it measures the dock surface, not #terminals.
  entry.container.classList.add("active");
  entry.fit.fit();
  void invoke("resize_pty", {
    tmuxSession: activeTerm,
    rows: entry.term.rows,
    cols: entry.term.cols,
  });
  entry.term.focus();
}

/** Restore the active terminal's container to #terminals (Console layout) and
 *  re-fit it there. */
function undockTerminal(): void {
  if (!activeTerm) return;
  const entry = terminals.get(activeTerm);
  if (!entry) return;
  terminalsEl.appendChild(entry.container);
  refitActive();
}

// ------------------------------------------------------------- split render
// Split lives only in console layout: it re-parents the same `.term-container`
// nodes (one PTY each) into pane cells, exactly like the board dock does. A
// ResizeObserver on each cell re-fits its terminal on any size change (window,
// divider, panel). Entering board collapses the split (see setLayout).

/** First occupied slot in TL,TR,BL,BR order (fallback focus target). */
function firstSlot(): Slot {
  return (["TL", "TR", "BL", "BR"] as Slot[]).find((s) => panes.has(s)) ?? "TL";
}

// Re-fit a terminal to its current container, batched to one rAF per frame.
const pendingFits = new Set<string>();
let fitScheduled = false;
function fitTerminal(name: string): void {
  const entry = terminals.get(name);
  if (!entry) return;
  entry.fit.fit();
  void invoke("resize_pty", { tmuxSession: name, rows: entry.term.rows, cols: entry.term.cols });
}
function scheduleFit(name: string): void {
  pendingFits.add(name);
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    for (const n of pendingFits) fitTerminal(n);
    pendingFits.clear();
  });
}
const paneResizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const name = (e.target as HTMLElement).dataset.term;
    if (name) scheduleFit(name);
  }
});

// Drop-zone preview overlay: four themed quadrants shown while a tab is dragged
// over #terminals. pointer-events:none so it never intercepts the drag.
const splitOverlay = document.createElement("div");
splitOverlay.id = "split-overlay";
const dzEls = {} as Record<Slot, HTMLDivElement>;
for (const s of ["TL", "TR", "BL", "BR"] as Slot[]) {
  const dz = document.createElement("div");
  dz.className = `dz ${s.toLowerCase()}`;
  dz.style.setProperty("--dz-color", SLOT_COLOR[s]);
  dzEls[s] = dz;
  splitOverlay.appendChild(dz);
}
terminalsEl.appendChild(splitOverlay);

/** Quadrant of #terminals under a viewport point. */
function quadrantAt(x: number, y: number): Slot {
  const r = terminalsEl.getBoundingClientRect();
  const left = x < r.left + r.width / 2;
  const top = y < r.top + r.height / 2;
  return top ? (left ? "TL" : "TR") : left ? "BL" : "BR";
}
function showSplitOverlay(slot: Slot): void {
  splitOverlay.classList.add("show");
  for (const s of Object.keys(dzEls) as Slot[]) dzEls[s].classList.toggle("hot", s === slot);
}
function hideSplitOverlay(): void {
  splitOverlay.classList.remove("show");
  for (const dz of Object.values(dzEls)) dz.classList.remove("hot");
}

/** Assign a dragged session to a quadrant. From single-pane this seeds a
 *  two-pane vertical split (the on-screen session takes the opposite column),
 *  so any first drop yields left|right — the documented default. Dragging one
 *  visible pane onto another swaps the two (neither is evicted); dragging a
 *  parked tab onto an occupied slot replaces it (the occupant parks, stays alive). */
function assignPane(slot: Slot, name: string): void {
  if (!terminals.has(name)) return;
  const wasSplit = splitActive();
  const srcSlot = [...panes].find(([, n]) => n === name)?.[0];
  if (srcSlot === slot) return; // dropped onto its own pane: no-op

  // Swap: both the dragged session and the target slot are already visible
  // panes, so trade their positions instead of collapsing/evicting.
  const occupant = panes.get(slot);
  if (wasSplit && srcSlot && occupant && occupant !== name) {
    panes.set(srcSlot, occupant);
    panes.set(slot, name);
    focusedSlot = slot;
    renderPanes();
    return;
  }

  if (srcSlot) panes.delete(srcSlot);
  if (!wasSplit) {
    const seed = activeTerm;
    if (seed && seed !== name) {
      const opposite: Record<Slot, Slot> = { TL: "TR", TR: "TL", BL: "BR", BR: "BL" };
      panes.set(opposite[slot], seed);
    }
  }
  panes.set(slot, name);
  if (!splitActive()) {
    // Couldn't form a split (e.g. only one session, dropped onto itself).
    panes.clear();
    activateTerminal(name);
    return;
  }
  focusedSlot = slot;
  renderPanes();
}

/** Load a session into a specific slot (used when clicking a parked tab in
 *  split mode); replaces the slot's current occupant, which parks but lives. */
function setPane(slot: Slot, name: string): void {
  if (!terminals.has(name)) return;
  for (const [s, n] of [...panes]) if (n === name && s !== slot) panes.delete(s);
  panes.set(slot, name);
  if (!splitActive()) {
    exitSplit(name);
    return;
  }
  focusedSlot = slot;
  renderPanes();
}

/** Remove a slot from the split (via its pane's × ); the session stays alive
 *  and returns to the tab bar. Collapses to single when fewer than two remain. */
function removePane(slot: Slot): void {
  panes.delete(slot);
  if (focusedSlot === slot) focusedSlot = firstSlot();
  if (splitActive()) renderPanes();
  else exitSplit([...panes.values()][0] ?? activeTerm);
}

/** Focus a pane: sync activeTerm (for Cmd+W / targetSession / dock), move the
 *  focus ring, and focus its xterm. */
function focusPane(slot: Slot): void {
  focusedSlot = slot;
  const name = panes.get(slot);
  if (name) activeTerm = name;
  for (const cell of terminalsEl.querySelectorAll<HTMLElement>(".pane")) {
    cell.classList.toggle("focused", cell.dataset.slot === slot);
  }
  if (name) terminals.get(name)?.term.focus();
  renderSidebar();
}

/** Tag each on-screen tab with its quadrant colour (top border). */
function updateTabPaneColors(): void {
  clearTabPaneColors();
  for (const [slot, name] of panes) {
    const entry = terminals.get(name);
    if (!entry) continue;
    entry.tab.classList.add("in-pane");
    entry.tab.style.setProperty("--pane-color", SLOT_COLOR[slot]);
  }
}
function clearTabPaneColors(): void {
  for (const entry of terminals.values()) {
    entry.tab.classList.remove("in-pane");
    entry.tab.style.removeProperty("--pane-color");
  }
}

function buildPane(slot: Slot, grow: number): HTMLDivElement {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.slot = slot;
  pane.style.flex = `${grow} 1 0`;
  pane.style.setProperty("--pane-color", SLOT_COLOR[slot]);
  const name = panes.get(slot)!;
  pane.dataset.term = name;
  const entry = terminals.get(name);

  const header = document.createElement("div");
  header.className = "pane-header";
  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = entry?.title ?? name;
  const close = document.createElement("button");
  close.className = "pane-close";
  close.textContent = "×";
  close.title = "Remove from split";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    removePane(slot);
  });
  header.append(title, close);
  pane.append(header);
  if (entry) pane.appendChild(entry.container); // move the container into the cell
  pane.addEventListener("mousedown", () => focusPane(slot));
  paneResizeObserver.observe(pane);
  return pane;
}

function makeColDivider(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "col-divider";
  d.addEventListener("pointerdown", (e) => startDividerDrag(e, d, "col", null));
  return d;
}
function makeRowDivider(which: "l" | "r", colEl: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "row-divider";
  d.addEventListener("pointerdown", (e) => startDividerDrag(e, d, "row", { which, colEl }));
  return d;
}
const clampRatio = (r: number): number => Math.min(0.85, Math.max(0.15, r));
// flex-basis 0 so the grow fraction maps linearly to pixel width/height (with
// basis:auto the panes' intrinsic size skews the ratio and makes the drag feel
// non-linear / reversed).
function applyColRatio(): void {
  const cols = terminalsEl.querySelectorAll<HTMLElement>(".split-col");
  if (cols.length === 2) {
    cols[0].style.flex = `${colRatio} 1 0`;
    cols[1].style.flex = `${1 - colRatio} 1 0`;
  }
}
function applyRowRatio(colEl: HTMLElement, ratio: number): void {
  const rows = colEl.querySelectorAll<HTMLElement>(".pane");
  if (rows.length === 2) {
    rows[0].style.flex = `${ratio} 1 0`;
    rows[1].style.flex = `${1 - ratio} 1 0`;
  }
}
// Pointer capture routes every move/up to the divider even when the pointer
// crosses an xterm surface (whose own mouse handling would otherwise swallow the
// mouseup and strand the drag — then a stale listener keeps following the cursor).
function startDividerDrag(
  e: PointerEvent,
  handle: HTMLElement,
  axis: "col" | "row",
  row: { which: "l" | "r"; colEl: HTMLElement } | null,
): void {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  if (axis === "row") document.body.classList.add("vertical");
  const onMove = (ev: PointerEvent) => {
    if (axis === "col") {
      const r = terminalsEl.getBoundingClientRect();
      if (!r.width) return;
      colRatio = clampRatio((ev.clientX - r.left) / r.width);
      applyColRatio();
      localStorage.setItem("cc-split-col", String(colRatio));
    } else if (row) {
      const r = row.colEl.getBoundingClientRect();
      if (!r.height) return;
      const ratio = clampRatio((ev.clientY - r.top) / r.height);
      if (row.which === "l") {
        leftRowRatio = ratio;
        localStorage.setItem("cc-split-rows-l", String(ratio));
      } else {
        rightRowRatio = ratio;
        localStorage.setItem("cc-split-rows-r", String(ratio));
      }
      applyRowRatio(row.colEl, ratio);
    }
  };
  const onUp = (ev: PointerEvent) => {
    document.body.classList.remove("resizing", "vertical");
    handle.releasePointerCapture(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

/** Rebuild the split scaffolding from the `panes` map (console layout only). */
function renderPanes(): void {
  if (!splitActive()) {
    exitSplit(activeTerm);
    return;
  }
  if (!focusedSlot || !panes.has(focusedSlot)) focusedSlot = firstSlot();
  if (layout !== "console") {
    updateTabPaneColors(); // split DOM only exists in console; rebuild on return
    return;
  }
  paneResizeObserver.disconnect();
  // Park every container as a hidden direct child, then drop the old cells.
  for (const entry of terminals.values()) {
    entry.container.classList.remove("active");
    terminalsEl.appendChild(entry.container);
  }
  for (const el of terminalsEl.querySelectorAll(".split-col, .col-divider")) el.remove();

  terminalsEl.classList.add("split");
  updatePlaceholder();

  const leftSlots = (["TL", "BL"] as Slot[]).filter((s) => panes.has(s));
  const rightSlots = (["TR", "BR"] as Slot[]).filter((s) => panes.has(s));
  const bothCols = leftSlots.length > 0 && rightSlots.length > 0;
  const columns: { slots: Slot[]; grow: number; which: "l" | "r"; ratio: number }[] = [];
  if (leftSlots.length)
    columns.push({ slots: leftSlots, grow: bothCols ? colRatio : 1, which: "l", ratio: leftRowRatio });
  if (rightSlots.length)
    columns.push({ slots: rightSlots, grow: bothCols ? 1 - colRatio : 1, which: "r", ratio: rightRowRatio });

  columns.forEach((col, ci) => {
    if (ci > 0) terminalsEl.insertBefore(makeColDivider(), splitOverlay);
    const colEl = document.createElement("div");
    colEl.className = "split-col";
    colEl.style.flex = `${col.grow} 1 0`;
    col.slots.forEach((slot, ri) => {
      if (ri > 0) colEl.appendChild(makeRowDivider(col.which, colEl));
      const grow = col.slots.length === 2 ? (ri === 0 ? col.ratio : 1 - col.ratio) : 1;
      colEl.appendChild(buildPane(slot, grow));
    });
    terminalsEl.insertBefore(colEl, splitOverlay); // keep the overlay last (on top)
  });

  updateTabPaneColors();
  focusPane(focusedSlot);
  for (const name of panes.values()) scheduleFit(name);
}

/** Leave split mode, keeping `keep` (if valid) as the single active terminal. */
function exitSplit(keep: string | null): void {
  const target = keep && terminals.has(keep) ? keep : (terminals.keys().next().value ?? null);
  panes.clear();
  focusedSlot = null;
  clearTabPaneColors();
  paneResizeObserver.disconnect();
  hideSplitOverlay();
  // Move every container back to a hidden direct child of #terminals, tear down
  // the split scaffolding, then re-show the kept terminal via the single path.
  for (const entry of terminals.values()) {
    entry.container.classList.remove("active");
    terminalsEl.appendChild(entry.container);
  }
  for (const el of terminalsEl.querySelectorAll(".split-col, .col-divider")) el.remove();
  terminalsEl.classList.remove("split");
  activeTerm = null; // force activateTerminal to re-show the kept terminal
  if (target) activateTerminal(target);
  else {
    updatePlaceholder();
    if (layout === "board") updateDockHeader();
  }
}

window.addEventListener("resize", () => {
  refitActive();
});

// Cmd+W closes the active terminal tab first; only when no tabs remain does it
// close the window (the OS default). Capture phase so it beats xterm's own key
// handling on the focused terminal. Cmd, not Ctrl: Ctrl+W is the terminal's
// delete-word and must reach the shell.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "w" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (activeTerm) {
      closeTerminal(activeTerm);
    } else {
      void getCurrentWindow().close();
    }
  },
  true,
);

/** Activate the open terminal tab at `index` (0-based), if it exists. */
function activateTabByIndex(index: number): void {
  const name = [...terminals.keys()][index];
  if (name) activateTerminal(name);
}

/** Cycle the active terminal tab by `delta` (wraps around). */
function cycleTab(delta: number): void {
  const names = [...terminals.keys()];
  if (!names.length) return;
  const cur = activeTerm ? names.indexOf(activeTerm) : -1;
  activateTerminal(names[(cur + delta + names.length) % names.length]);
}

/** Move the sidebar cursor by `delta` and attach the newly selected session. */
function cycleSession(delta: number): void {
  // Seed the cursor from the active terminal so the first press moves relative
  // to what's on screen, not from the top of the list.
  if (!selectedId) {
    const cur = targetSession();
    if (cur) selectRow(cur.id);
  }
  moveSelection(delta);
  const s = selectedId ? findSession(selectedId) : undefined;
  if (s) void openTerminal(s);
}

// iTerm-style tab / session navigation. These are app actions (they never reach
// the shell), so — like Cmd+W — they're handled here rather than as terminal
// bytes. Capture phase to beat xterm's key handling on the focused terminal.
// Cmd+1..9 selects a tab; Cmd+Opt+Left/Right cycles tabs; Cmd+Opt+Up/Down walks
// the sidebar sessions. Bare Cmd+Left/Right stays the terminal's line-start/end.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.ctrlKey || keyOverlayOpen()) return;
    if (!e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      activateTabByIndex(Number(e.key) - 1);
      return;
    }
    if (!e.altKey || e.shiftKey) return;
    const move: Record<string, () => void> = {
      ArrowLeft: () => cycleTab(-1),
      ArrowRight: () => cycleTab(1),
      ArrowUp: () => cycleSession(-1),
      ArrowDown: () => cycleSession(1),
    };
    const fn = move[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  },
  true,
);

/** Open the file explorer rooted at the active session's repo. */
function openFileExplorer(): void {
  const name = activeTerm;
  const s = name
    ? groups.flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name)
    : undefined;
  if (!name || !s) {
    toast("No active session", "error");
    return;
  }
  void openExplorer({
    sessionId: s.id,
    tmuxSession: name,
    rootLabel: groupOf(s.id)?.name ?? s.title,
    focusTerminal: () => terminals.get(name)?.term.focus(),
  });
}

// PROTOTYPE: markdown viewer — Cmd+M toggles it over the active session's
// repo, same capture-phase accel pattern as Cmd+E below. Delete with
// markdownViewerPrototype.ts.
function openMarkdownViewerForActiveSession(): void {
  const name = activeTerm;
  const s = name
    ? groups.flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name)
    : undefined;
  if (!name || !s) {
    toast("No active session", "error");
    return;
  }
  void openMarkdownViewer({
    sessionId: s.id,
    rootLabel: groupOf(s.id)?.name ?? s.title,
    focusTerminal: () => terminals.get(name)?.term.focus(),
  });
}
window.addEventListener(
  "keydown",
  (e) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const accel = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey && !isMac);
    if (e.key !== "m" || !accel || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (isMarkdownViewerOpen()) closeMarkdownViewer();
    else openMarkdownViewerForActiveSession();
  },
  true,
);

// Cmd+E toggles the file explorer. On Linux/Windows (.deb/.AppImage), which have
// no Cmd, Ctrl+E is also accepted so keyboard users still have an open path; on
// macOS Ctrl+E stays reserved for the terminal's move-to-end-of-line. Capture
// phase so it opens even while a terminal is focused, the same technique as
// Cmd+W / Cmd+1..9 above.
window.addEventListener(
  "keydown",
  (e) => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const accel = (e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey && !isMac);
    if (e.key !== "e" || !accel || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (isExplorerOpen()) {
      closeExplorer();
      if (activeTerm) terminals.get(activeTerm)?.term.focus();
    } else {
      openFileExplorer();
    }
  },
  true,
);

makeResizable({
  key: "cc-sidebar-width",
  target: document.querySelector<HTMLElement>("#sidebar")!,
  edge: "right",
  min: 200,
  max: 640,
  onResize: refitActive,
});
makeResizable({
  key: "cc-detail-width",
  target: detailEl,
  edge: "left",
  min: 240,
  max: 720,
  onResize: refitActive,
});

// ------------------------------------------------------------- detail panel

let detailId: string | null = null;
let detailTimer: ReturnType<typeof setInterval> | null = null;
let detailPrUrl: string | null = null; // PR url from the last fetched detail, for the footer

type Summary = { state: "loading" } | { state: "ready"; text: string } | { state: "error"; text: string };
const summaries = new Map<string, Summary>(); // keyed by session id, app-session cache

/** Parse the backend's git-style diffstat summary ("3 files changed,
 *  124 insertions(+), 38 deletions(-)"; zero clauses omitted). Null when the
 *  string isn't that shape. */
function parseDiffStat(diffStat: string): { files: number; adds: number; dels: number } | null {
  const m = diffStat.match(
    /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/,
  );
  if (!m) return null;
  return { files: Number(m[1]), adds: Number(m[2] ?? 0), dels: Number(m[3] ?? 0) };
}

/** Proportional add/remove bar for a parsed diffstat. */
function diffstatBar(adds: number, dels: number): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "diffstat-bar";
  const total = adds + dels;
  const a = document.createElement("span");
  a.className = "added";
  a.style.width = `${(adds / total) * 100}%`;
  const r = document.createElement("span");
  r.className = "removed";
  r.style.width = `${(dels / total) * 100}%`;
  bar.append(a, r);
  return bar;
}

function metaRow(label: string, value: string): [HTMLElement, HTMLElement] {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

/** Update the meta list without rebuilding it when the row shape is unchanged,
 *  so the 2s poll never destroys an in-progress selection of a branch or PR
 *  URL. Full rebuild only when the labels themselves change (PR row appears or
 *  disappears); otherwise touch a `dd`'s text only when its value differs. */
function renderMeta(rows: [string, string][]): void {
  const sameShape =
    detailMetaEl.childElementCount === rows.length * 2 &&
    rows.every(([label], i) => detailMetaEl.children[i * 2].textContent === label);
  if (sameShape) {
    rows.forEach(([, value], i) => {
      const dd = detailMetaEl.children[i * 2 + 1];
      if (dd.textContent !== value) dd.textContent = value;
    });
    return;
  }
  detailMetaEl.innerHTML = "";
  for (const [label, value] of rows) detailMetaEl.append(...metaRow(label, value));
}

function renderDetail(d: SessionDetail): void {
  detailTitleEl.textContent = d.title;
  detailTitleEl.title = d.title; // recover the full string when truncated
  detailPrUrl = d.pr_url;

  const status =
    d.status.toLowerCase() === "running" ? `running · ${d.agent_state}` : d.status.toLowerCase();
  // Order per the brief: branch / (worktree — omitted, not surfaced to the
  // frontend SessionDetail) / PR / status; project/program/created kept.
  const rows: [string, string][] = [["Project", d.project_name], ["Branch", d.branch]];
  if (d.pr_number != null) {
    rows.push([
      "PR",
      `#${d.pr_number} (${d.pr_draft ? "draft" : d.pr_state.toLowerCase()})${d.pr_url ? ` — ${d.pr_url}` : ""}`,
    ]);
  }
  rows.push(["Status", status], ["Program", d.program], ["Created", new Date(d.created_at).toLocaleString()]);
  renderMeta(rows);

  detailDiffstatEl.innerHTML = "";
  const stat = d.diff_stat ? parseDiffStat(d.diff_stat) : null;
  detailChangesEl.textContent =
    stat === null ? "Changes" : `Changes · ${stat.files} file${stat.files === 1 ? "" : "s"}`;
  if (stat) {
    const counts = document.createElement("div");
    counts.className = "diffstat-counts";
    const a = document.createElement("span");
    a.className = "added";
    a.textContent = `+${stat.adds}`;
    const r = document.createElement("span");
    r.className = "removed";
    r.textContent = `−${stat.dels}`;
    counts.append(a, r);
    detailDiffstatEl.appendChild(counts);
    if (stat.adds + stat.dels > 0) detailDiffstatEl.appendChild(diffstatBar(stat.adds, stat.dels));
  } else if (d.diff_stat) {
    // Unrecognized summary shape — show it verbatim rather than dropping it.
    detailDiffstatEl.textContent = d.diff_stat;
  } else {
    detailDiffstatEl.textContent = "No changes";
  }

  // Tag chips: derive from the matching snapshot row's PR labels (real data;
  // no dedicated tag source exists). Empty when the session has no labels.
  detailTagsEl.innerHTML = "";
  const row = groups.flatMap((g) => g.sessions).find((x) => x.id === d.id);
  for (const label of row?.pr_labels ?? []) {
    const chip = document.createElement("span");
    chip.className = "detail-tag";
    chip.textContent = label;
    detailTagsEl.appendChild(chip);
  }

  // Footer: Open PR is enabled only when this session has a PR url.
  detailPrEl.disabled = !d.pr_url;
}

function renderSummary(): void {
  if (!detailId) return;
  const summary = summaries.get(detailId);
  detailSummaryEl.classList.remove("placeholder", "error");
  summaryGenEl.disabled = summary?.state === "loading";
  summaryGenEl.textContent = summary?.state === "ready" ? "↻ Regenerate" : "↻ Generate";
  if (!summary) {
    detailSummaryEl.classList.add("placeholder");
    detailSummaryEl.textContent = "No summary yet — Generate sends the branch diff to Claude.";
  } else if (summary.state === "loading") {
    detailSummaryEl.classList.add("placeholder");
    detailSummaryEl.textContent = "Generating…";
  } else if (summary.state === "error") {
    detailSummaryEl.classList.add("error");
    detailSummaryEl.textContent = summary.text;
  } else {
    detailSummaryEl.textContent = summary.text;
  }
}

async function generateSummary(): Promise<void> {
  if (!detailId) return;
  const id = detailId;
  if (summaries.get(id)?.state === "loading") return;
  summaries.set(id, { state: "loading" });
  renderSummary();
  try {
    const text = await invoke<string>("generate_summary", { id });
    summaries.set(id, { state: "ready", text });
  } catch (e) {
    summaries.set(id, { state: "error", text: String(e) });
  }
  renderSummary();
}

summaryGenEl.addEventListener("click", () => void generateSummary());

async function refreshDetail(): Promise<void> {
  if (!detailId) return;
  let d: SessionDetail | null = null;
  try {
    d = await invoke<SessionDetail | null>("get_session_detail", { id: detailId });
  } catch {
    return; // transient failure; next tick retries
  }
  if (!detailId) return; // closed while fetching
  if (!d) {
    closeDetail();
    return;
  }
  renderDetail(d);
}

function closeDetail(): void {
  detailId = null;
  detailPrUrl = null;
  if (detailTimer) clearInterval(detailTimer);
  detailTimer = null;
  detailEl.classList.add("hidden");
  refitActive();
}

function toggleDetail(s: SessionRow): void {
  if (detailId === s.id) {
    closeDetail();
    return;
  }
  detailId = s.id;
  detailPrUrl = null;
  detailEl.classList.remove("hidden");
  detailTitleEl.textContent = s.title;
  detailMetaEl.innerHTML = "";
  detailChangesEl.textContent = "Changes";
  detailDiffstatEl.textContent = "Loading…";
  detailTagsEl.innerHTML = "";
  detailPrEl.disabled = true;
  renderSummary();
  if (detailTimer) clearInterval(detailTimer);
  detailTimer = setInterval(() => void refreshDetail(), 2000);
  void refreshDetail();
  refitActive();
}

document.querySelector("#detail-close")!.addEventListener("click", closeDetail);
detailReviewEl.addEventListener("click", () => {
  if (detailId) void openReview(detailId, detailTitleEl.textContent ?? "");
});
detailPrEl.addEventListener("click", () => {
  if (detailPrUrl) void invoke("open_external", { url: detailPrUrl });
});

/**
 * Crash-loop guard, cap 3 *consecutive* ends per tmux name. "Consecutive"
 * means in quick succession: an end more than a minute after the previous one
 * starts a fresh count, so a session that ran healthily for a while regains
 * its auto-restart budget (the TUI gets this for free by scoping its counter
 * to one attach loop).
 */
const consecutiveEnds = new Map<string, { count: number; lastEnd: number }>();

function recordEndAndCheckRestart(name: string): boolean {
  if (name.endsWith("-sh") || name === "cc-commander") return false;
  const prev = consecutiveEnds.get(name);
  const now = Date.now();
  const count = prev && now - prev.lastEnd < 60_000 ? prev.count + 1 : 1;
  consecutiveEnds.set(name, { count, lastEnd: now });
  return count <= 3;
}

/**
 * Auto-restart a crashed session by reconnecting the PTY on the SAME terminal,
 * without tearing it down. This preserves the terminal's placement (its pane in
 * split mode, or parked/active in single mode) and the user's focus. A
 * user-initiated attach deliberately loads into the focused pane; an autonomous
 * restart must not — otherwise a background tab finishing would hijack the pane
 * you're working in, or a crashed pane would reappear in the wrong quadrant.
 */
async function restartTerminalInPlace(name: string): Promise<void> {
  const entry = terminals.get(name);
  if (!entry) return;
  try {
    await invoke("restart_fresh", { tmuxSession: name });
    const onData = new Channel<number[]>();
    onData.onmessage = (chunk) => entry.term.write(new Uint8Array(chunk));
    await invoke("attach", { tmuxSession: name, onData });
    entry.dead = false;
    entry.tab.classList.remove("dead");
    // Refit wherever it currently lives; parked terminals need no refit.
    if (splitActive() && [...panes.values()].includes(name)) scheduleFit(name);
    else if (activeTerm === name) refitActive();
  } catch (e) {
    entry.term.write(`\r\nAuto-restart failed: ${e}\r\n`);
  }
}

void listen<{ session: string; ended: boolean }>("pty-exit", (event) => {
  const { session: name, ended } = event.payload;
  const entry = terminals.get(name);
  if (!entry) return;
  entry.dead = true;
  entry.tab.classList.add("dead");

  // The tmux session ended (program exited/crashed) rather than a detach:
  // auto-restart fresh and re-attach in place, with the crash-loop guard — the
  // same behaviour as the TUI's attach loop.
  if (ended && recordEndAndCheckRestart(name)) {
    entry.term.write("\r\n\x1b[90m[session ended — restarting…]\x1b[0m\r\n");
    void restartTerminalInPlace(name);
    return;
  }
  entry.term.write("\r\n\x1b[90m[detached — click session to re-attach]\x1b[0m\r\n");
});

// ----------------------------------------------------------------- sidebar

let groups: ProjectGroup[] = [];
let layout: "console" | "board" = (localStorage.getItem("cc-layout") as "console" | "board") ?? "console";
let viewMode = "project";
let sections: SectionBucket[] | null = null;
let sectionNames: string[] = [];
// Key of the project header with an open create-input. In project view this is
// the bare project id; in section view it's scoped to the section (see
// `sectionCreateKey`) so the same project across sections opens independently.
let newSessionProject: string | null = null;
let renamingId: string | null = null; // session id being renamed inline
let topInput: "add" | "scan" | null = null; // sidebar-top path input mode
// Project the session list is filtered to (toggled from the projects rail), or
// null for "all projects". Composes with whichever grouping is active.
let projectFilter: string | null = null;

// GUI-only "Status" grouping override (the GROUP BY control's third segment):
// groups the sidebar by activity tier instead of the backend-owned viewMode —
// the crate's ViewMode has no status variant, so like the layout preference
// this lives in localStorage and leaves the backend mode untouched underneath.
let statusGrouping = localStorage.getItem("cc-status-grouping") === "1";

function setStatusGrouping(on: boolean): void {
  if (on === statusGrouping) return;
  statusGrouping = on;
  localStorage.setItem("cc-status-grouping", on ? "1" : "0");
  renderSidebar();
}

// Board layout: which cards are visible (filter pills) + a name search. Mirrors
// projectFilter's "local UI state, re-render on change" shape.
let boardSearch = "";
// Project multiselect filter: the set of selected project ids, or null for "all
// projects" (the default). Cards whose project isn't selected are hidden across
// every section column.
let boardProjectFilter: Set<string> | null = null;
// Hide section columns with zero visible cards (persisted).
let hideEmptyColumns = localStorage.getItem("cc-board-hide-empty") === "1";

const SECTION_VIEW = (): boolean => sections !== null;

/** Create-input key for a project sub-header inside a section. The `sect:`
 *  prefix can't collide with a bare project uuid (project-view key). */
const sectionCreateKey = (section: string, projectId: string): string =>
  `sect:${section}\x00${projectId}`;

// Collapsed sidebar groups ("proj:<id>" / "sect:<name>"), persisted.
const collapsed = new Set<string>(
  JSON.parse(localStorage.getItem("cc-collapsed") ?? "[]") as string[],
);

function toggleCollapsed(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  localStorage.setItem("cc-collapsed", JSON.stringify([...collapsed]));
  renderSidebar();
}

/** Chevron + collapse-toggling click handler for a group header. */
function makeCollapsible(header: HTMLDivElement, name: HTMLSpanElement, key: string): boolean {
  const isCollapsed = collapsed.has(key);
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = isCollapsed ? "▸ " : "▾ ";
  name.prepend(chevron);
  header.classList.add("collapsible");
  header.addEventListener("click", () => toggleCollapsed(key));
  return isCollapsed;
}

/** A thin subtle hairline that grows to fill the rest of a group header row
 *  (after the name + count), trailing off toward the edge. */
function headerRule(): HTMLSpanElement {
  const rule = document.createElement("span");
  rule.className = "header-rule";
  return rule;
}

function findSession(id: string): SessionRow | undefined {
  for (const g of groups) {
    const s = g.sessions.find((s) => s.id === id);
    if (s) return s;
  }
  return undefined;
}

// ------------------------------------------------- keyboard selection model

// Keyboard cursor for the sidebar (the TUI's tree cursor). Session ids of
// visible rows, one array per rendered group, rebuilt on every full render.
let selectedId: string | null = null;
let visibleGroups: string[][] = [];

function updateSelectionClasses(): void {
  for (const [id, refs] of rowRefs) {
    const sel = id === selectedId;
    refs.row.classList.toggle("selected", sel);
    refs.row.setAttribute("aria-selected", sel ? "true" : "false");
  }
  // The listbox tracks its cursor via aria-activedescendant, so assistive tech
  // follows the same selectedId the keyboard chords move.
  sessionsEl.setAttribute(
    "aria-activedescendant",
    selectedId ? `row-${selectedId}` : "",
  );
  // Board cards share the sidebar's selection model.
  for (const [id, card] of boardCardRefs) {
    card.classList.toggle("selected", id === selectedId);
  }
  if (selectedId) {
    rowRefs.get(selectedId)?.row.scrollIntoView({ block: "nearest" });
  }
}

function selectRow(id: string | null): void {
  selectedId = id;
  updateSelectionClasses();
}

function moveSelection(delta: number): void {
  const flat = visibleGroups.flat();
  if (!flat.length) return;
  const idx = selectedId ? flat.indexOf(selectedId) : -1;
  const next = idx === -1 ? (delta > 0 ? 0 : flat.length - 1) : idx + delta;
  selectRow(flat[Math.min(flat.length - 1, Math.max(0, next))]);
}

/** Jump to the first row of the next/previous group and show its terminal. */
function moveGroup(dir: 1 | -1): void {
  const nonEmpty = visibleGroups.filter((g) => g.length);
  if (!nonEmpty.length) return;
  const cur = nonEmpty.findIndex((g) => selectedId !== null && g.includes(selectedId));
  const next = cur === -1 ? 0 : (cur + dir + nonEmpty.length) % nonEmpty.length;
  const id = nonEmpty[next][0];
  selectRow(id);
  // Switching groups attaches the target session so the displayed terminal (and
  // its `.active` highlight) follows the cursor, rather than leaving the old
  // session shown/highlighted.
  const s = findSession(id);
  if (s) void openTerminal(s);
}

/** The session keyboard actions operate on: cursor first, attached tab second. */
function targetSession(): SessionRow | undefined {
  if (selectedId) {
    const s = findSession(selectedId);
    if (s) return s;
  }
  if (activeTerm) {
    for (const g of groups) {
      const s = g.sessions.find((x) => x.tmux_session_name === activeTerm);
      if (s) return s;
    }
  }
  return undefined;
}

function groupOf(sessionId: string): ProjectGroup | undefined {
  return groups.find((g) => g.sessions.some((s) => s.id === sessionId));
}

/** Liveness-dot state classes set by applyStatusGlyph. `dot-running` carries
 *  the pulse; the rest are static colour. Removed wholesale before re-applying. */
const STATUS_GLYPH_CLASSES = [
  "dot-running",
  "dot-finished",
  "dot-idle",
  "dot-stopped",
  "dot-transient",
  "dot-waiting",
  "dot-hibernated",
];

/** Set `el`'s liveness dot (colour/pulse/tooltip) from a session's status.
 *  Shared by the sidebar rows and the terminal tabs so they stay in lockstep.
 *  The element renders as an 8px circle (see `.dot`/.glyph/.tab-glyph CSS); the
 *  state class drives its colour and the running pulse. */
function applyStatusGlyph(el: HTMLSpanElement, s: SessionRow): void {
  el.classList.remove(...STATUS_GLYPH_CLASSES);
  el.textContent = "";
  let cls: string;
  let title: string;
  if (s.unread) {
    // Finished while away — surface as the "finished" colour regardless of the
    // underlying agent state.
    cls = "dot-finished";
    title = "finished — needs attention";
  } else if (s.status === "running") {
    if (s.agent_state === "working") {
      cls = "dot-running";
      title = "running";
    } else if (s.agent_state === "waitingforinput") {
      // Distinct from the in-progress dot: a yellow "?" glyph, not a circle.
      cls = "dot-waiting";
      el.textContent = "?";
      title = "waiting for input";
    } else if (s.agent_state === "idle") {
      cls = "dot-idle";
      title = "idle";
    } else {
      cls = "dot-idle";
      title = s.agent_state;
    }
  } else if (s.hibernated) {
    // Auto-hibernated (status is "stopped"): a moon glyph distinct from a
    // plainly-stopped session, since it can be woken to resume its agent.
    cls = "dot-hibernated";
    el.textContent = "☾";
    title = "hibernated — wake to resume";
  } else if (s.status === "stopped") {
    cls = "dot-stopped";
    title = "stopped";
  } else {
    cls = "dot-transient"; // creating / merging / pushing / cascade_paused
    title = s.status;
  }
  el.classList.add(cls);
  el.title = title;
}

function statusGlyph(s: SessionRow): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "glyph dot";
  applyStatusGlyph(el, s);
  return el;
}

/** Derive a session's liveness state key by reading applyStatusGlyph's own
 *  output (probe → `dot-running` → "running"), so the status chips, the board
 *  accent bar, and the terminal-tab dots all stay in lockstep with one mapping.
 *  Mirrors boardStateClass's probe. */
function sessionStateKey(s: SessionRow): StatusState {
  const probe = document.createElement("span");
  applyStatusGlyph(probe, s);
  for (const cls of STATUS_GLYPH_CLASSES) {
    if (probe.classList.contains(cls)) return cls.slice(4) as StatusState; // dot-running → running
  }
  return "idle";
}

/** A session's activity tier for the Status grouping, via the shared state
 *  key so it stays in lockstep with the dots and chips. */
function sessionTier(s: SessionRow): StatusTier {
  return stateTier(sessionStateKey(s));
}

/** The chip word for a session's state. Transient states (creating/merging/
 *  pushing/…) carry the humanized status rather than a fixed word. */
function sessionStateWord(s: SessionRow, key: StatusState): string {
  return key === "transient"
    ? s.status.charAt(0).toUpperCase() + s.status.slice(1).replace(/_/g, " ")
    : stateChipInfo(key).word;
}

/** The shared shape+colour+word chip for a session's liveness state. */
function sessionStatusChip(s: SessionRow): HTMLSpanElement {
  const key = sessionStateKey(s);
  return statusChip(key, { word: sessionStateWord(s, key) });
}

/** Number of project-identity palette slots (--proj-0..--proj-7 in :root). */
const PROJ_COLORS = 8;

/** Deterministically hash a project_id to one of the PROJ_COLORS palette slots.
 *  FNV-1a over the id so the same project always maps to the same colour. */
function projIndex(projectId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PROJ_COLORS;
}

/** CSS class (`proj-N`) carrying a project's identity colour via `--proj-color`.
 *  Consumers read `var(--proj-color)` — never an inline hex. */
function projClass(projectId: string): string {
  return `proj-${projIndex(projectId)}`;
}

/** Mirror each open tab's status glyph from the latest session snapshot. Tabs
 *  with no matching session (e.g. commander) keep their glyph hidden. */
function updateTabGlyphs(): void {
  for (const [name, entry] of terminals) {
    const s = groups.flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name);
    if (s) {
      entry.glyph.hidden = false;
      applyStatusGlyph(entry.glyph, s);
    } else {
      entry.glyph.hidden = true;
    }
  }
}

function actionButton(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "row-action";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/** Destructive actions require a second click within 2.5s. */
function confirmButton(
  label: string,
  title: string,
  onConfirm: () => void,
): HTMLButtonElement {
  const btn = actionButton(label, title, () => {
    if (btn.classList.contains("confirm")) {
      onConfirm();
    } else {
      btn.classList.add("confirm");
      btn.textContent = "sure?";
      setTimeout(() => {
        btn.classList.remove("confirm");
        btn.textContent = label;
      }, 2500);
    }
  });
  return btn;
}

/** Re-fetch the sidebar snapshot now instead of waiting for the 2s tick. */
async function refreshNow(): Promise<void> {
  try {
    applySnapshot(await invoke<Snapshot>("get_groups"));
  } catch {
    // transient; the next push tick recovers
  }
}

/** Plain-language verb per lifecycle/command action, for error toasts. */
const ACTION_VERB: Record<string, string> = {
  kill_session: "stop the session",
  restart_session: "restart the session",
  restart_fresh: "restart the session fresh",
  delete_session: "delete the session",
  move_to_section: "move the session",
  cascade_merge: "merge the stack",
  push_stack: "push the stack",
  cascade_resume: "resume the stack",
  cascade_abandon: "abandon the stack",
};

/** Error toast naming the action in plain language; the raw backend error is
 *  kept on the hover title rather than shown inline. */
function actionErrorToast(action: string, e: unknown): void {
  const verb = ACTION_VERB[action] ?? action.replace(/_/g, " ");
  toast(`Couldn't ${verb}.`, "error", String(e));
}

async function lifecycle(action: string, id: string): Promise<void> {
  await lifecycleArgs(action, { id });
}

async function lifecycleArgs(action: string, args: Record<string, unknown>): Promise<void> {
  try {
    await invoke(action, args);
  } catch (e) {
    actionErrorToast(action, e);
  }
  await refreshNow();
}

/** Invoke a long-running command and surface its summary (or error). */
async function invokeToast(action: string, args: Record<string, unknown>): Promise<void> {
  try {
    const msg = await invoke<string | null>(action, args);
    if (msg) toast(msg);
  } catch (e) {
    actionErrorToast(action, e);
  }
  await refreshNow();
}

// Optimistic-update overlays: sessions deleted (or retitled) locally before
// the backend confirms, applied over every incoming snapshot. A mask is held
// until a snapshot *confirms* the change (session absent for a delete; new
// title present for a rename) — NOT merely until the invoke resolves. The 2s
// push loop can build a snapshot just before our mutation lands and deliver it
// just after, so clearing on resolve alone would flash the stale row/title
// back until the next tick. On invoke error the mask is force-cleared instead.
const pendingDeletes = new Set<string>();
const pendingTitles = new Map<string, string>();

function applyPendingOverlays(snap: Snapshot): void {
  if (!pendingDeletes.size && !pendingTitles.size) return;

  // Reconcile against the raw (pre-mask) snapshot: drop masks the backend has
  // caught up on, so they don't linger and suppress a later re-creation.
  const present = new Map<string, string>();
  for (const g of snap.groups) for (const s of g.sessions) present.set(s.id, s.title);
  for (const id of [...pendingDeletes]) if (!present.has(id)) pendingDeletes.delete(id);
  for (const [id, title] of [...pendingTitles]) {
    if (present.get(id) === title) pendingTitles.delete(id);
  }

  for (const g of snap.groups) {
    g.sessions = g.sessions.filter((s) => !pendingDeletes.has(s.id));
    for (const s of g.sessions) {
      const title = pendingTitles.get(s.id);
      if (title) s.title = title;
    }
  }
  if (snap.sections) {
    for (const b of snap.sections) {
      b.session_ids = b.session_ids.filter((id) => !pendingDeletes.has(id));
    }
  }
}

/** Optimistically remove the row, then delete in the background. */
function deleteSession(s: SessionRow): void {
  closeTerminal(s.tmux_session_name);
  pendingDeletes.add(s.id);
  for (const g of groups) g.sessions = g.sessions.filter((row) => row.id !== s.id);
  if (sections) for (const b of sections) b.session_ids = b.session_ids.filter((id) => id !== s.id);
  renderSidebar();
  renderBoard();
  updateTitleBarCounts();
  invoke("delete_session", { id: s.id })
    .then(() => refreshNow()) // a fresh snapshot confirms absence and clears the mask
    .catch((e) => {
      pendingDeletes.delete(s.id); // failed: un-mask so the row returns
      actionErrorToast("delete_session", e);
      void refreshNow();
    });
}

type RowRefs = {
  row: HTMLDivElement;
  main: HTMLDivElement;
  actions: HTMLDivElement;
  status: string;
  session: SessionRow;
};

const rowRefs = new Map<string, RowRefs>(); // keyed by session id

function buildActions(s: SessionRow): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.appendChild(actionButton("ⓘ", "Session details", () => toggleDetail(s)));
  actions.appendChild(actionButton("±", "Review diff", () => void openReview(s.id, s.title)));
  if (s.status === "stopped") {
    actions.appendChild(
      actionButton(
        "▶",
        s.hibernated ? "Wake session" : "Restart session",
        () => void lifecycle("restart_session", s.id),
      ),
    );
  }
  if (s.status === "running") {
    actions.appendChild(
      confirmButton("■", "Stop session", () => void lifecycle("kill_session", s.id)),
    );
  }
  actions.appendChild(
    confirmButton("✕", "Delete session (removes worktree + tmux, keeps the branch)", () => deleteSession(s)),
  );
  return actions;
}

/** PR badge: number colored by state, ✓/✗ review decision, draft styling. */
function prBadge(s: SessionRow): HTMLSpanElement | null {
  if (s.pr_number == null) return null;
  const badge = document.createElement("span");
  badge.className = `pr-badge pr-${s.pr_state ?? "open"}`;
  if (s.pr_draft) badge.classList.add("pr-draft");
  let text = `#${s.pr_number}`;
  if (s.review_decision === "approved") text += " ✓";
  if (s.review_decision === "changes_requested") text += " ✗";
  badge.textContent = text;
  badge.title =
    `PR #${s.pr_number} — ${s.pr_draft ? "draft " : ""}${s.pr_state ?? "open"}` +
    (s.review_decision ? `, ${s.review_decision.replace(/_/g, " ")}` : "") +
    (s.pr_labels.length ? `\nLabels: ${s.pr_labels.join(", ")}` : "");
  return badge;
}

/** True when the branch is just a slug of the title (the common case), so it
 *  carries no information worth its own column. */
function branchMatchesTitle(title: string, branch: string): boolean {
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug(title) === slug(branch);
}

/** Rebuild the inner content of a row's main span (cheap; no input state).
 *  `actions` is the row's persistent hover-action element (see RowRefs): it's
 *  re-appended at the sub-line's trailing edge so confirm state survives. */
function fillRowMain(main: HTMLDivElement, s: SessionRow, actions: HTMLDivElement): void {
  main.innerHTML = "";

  // Top line: liveness dot · name · PR badge · right-side chips. The dot is the
  // fast-scan colour at the row's fixed left edge; the labeled word (Running /
  // Done / …) lives on the sub-line so the title gets the full line width.
  const line = document.createElement("div");
  line.className = "row-line";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = s.title;
  title.title = `Branch: ${s.branch}`;
  line.append(statusGlyph(s), title);

  const badge = prBadge(s);
  if (badge) line.appendChild(badge);

  // Right-side chips: ✎ pending comments, ⚠ pull blocked (project-level auto
  // -pull block). Pushed right by .row-chips margin-left:auto.
  const chips = document.createElement("span");
  chips.className = "row-chips";
  // SessionRow carries only has_pending_comments (no count), so the chip reads
  // "✎ Comments" rather than spelling out a number.
  if (s.has_pending_comments) {
    chips.appendChild(commentsChip(undefined, "Has pending review comments"));
  }
  // pull_blocked is a project-level field; surface ⚠ on rows of a blocked
  // project. (No session-level blocked flag exists — see recon risks.)
  const blocked = groupOf(s.id)?.pull_blocked;
  if (blocked) {
    chips.appendChild(pullBlockedChip(`Auto-pull blocked: ${blocked}`));
  }
  if (chips.childElementCount) line.appendChild(chips);

  // Sub-line: the labeled status chip (word-only here — the leading dot already
  // carries shape+colour, so the chip's own dot is hidden by a row-scoped rule),
  // plus the branch when it diverges from the title. SessionRow carries no
  // diff_stat (only SessionDetail does, and we avoid per-row fetches), so the
  // prototype's "+adds −dels" beside the chip has no source on a row.
  const sub = document.createElement("div");
  sub.className = "row-sub";
  sub.appendChild(sessionStatusChip(s));
  if (!branchMatchesTitle(s.title, s.branch)) {
    const branch = document.createElement("span");
    branch.className = "meta";
    branch.textContent = s.branch;
    sub.append(branch);
  }
  // Hover actions ride the sub-line (in line with the status chip) so revealing
  // them doesn't add a line and shift the rows below.
  sub.appendChild(actions);
  main.append(line, sub);
}

function sessionMenuItems(refs: RowRefs): MenuItem[] {
  const s = refs.session;
  // Core actions, in the order from the design brief.
  const items: MenuItem[] = [
    { label: "Attach", shortcut: kb("select"), action: () => void openTerminal(s) },
    { label: "Open shell", shortcut: kb("select_shell"), action: () => void openShell(s) },
    { label: "Review diff", shortcut: kb("open_review_diff"), action: () => void openReview(s.id, s.title) },
    {
      label: "Rename…",
      shortcut: kb("rename_session"),
      action: () => {
        renamingId = s.id;
        renderSidebar();
      },
    },
    "separator",
    {
      label: s.hibernated ? "Wake" : "Restart",
      shortcut: kb("restart_session"),
      action: () => void lifecycle("restart_session", s.id),
    },
    {
      label: "Restart fresh",
      action: () => {
        void invoke("restart_fresh", { tmuxSession: s.tmux_session_name })
          .catch((e) => toast(`restart_fresh failed: ${e}`, "error"))
          .finally(() => void refreshNow());
      },
    },
    {
      label: "Stop",
      sublabel: "stops the process, keeps the worktree",
      warning: true,
      action: () => void lifecycle("kill_session", s.id),
    },
    "separator",
    {
      label: "Delete session…",
      sublabel: "removes worktree + tmux, keeps the branch",
      danger: true,
      shortcut: kb("delete_session"),
      action: () => {
        void deleteSessionDialog(s.title, s.branch).then((ok) => {
          if (ok) deleteSession(s);
        });
      },
    },
  ];

  // Secondary capabilities, preserved below a separator so the rework doesn't
  // drop existing functionality (details, editor, PR, cascade, sections).
  const extras: MenuItem[] = [
    { label: "Details", action: () => toggleDetail(s) },
    { label: "Open in editor", shortcut: kb("open_in_editor"), action: () => void lifecycle("open_in_editor", s.id) },
  ];
  if (s.pr_url) {
    const url = s.pr_url;
    extras.push({
      label: `Open PR #${s.pr_number}`,
      shortcut: kb("open_pull_request"),
      action: () => void invoke("open_external", { url }),
    });
  }
  extras.push({
    label: "Cascade-merge main → stack",
    shortcut: kb("cascade_merge_main"),
    action: () => void invokeToast("cascade_merge", { id: s.id }),
  });
  extras.push({
    label: "Push stack to origin",
    shortcut: kb("push_stack"),
    action: () => void invokeToast("push_stack", { id: s.id }),
  });
  if (s.status === "cascade_paused") {
    extras.push({
      label: "Resume cascade",
      shortcut: kb("cascade_resume"),
      action: () => void invokeToast("cascade_resume", {}),
    });
    extras.push({
      label: "Abandon cascade",
      danger: true,
      shortcut: kb("cascade_abandon"),
      action: () => void invokeToast("cascade_abandon", {}),
    });
  }
  if (sectionNames.length) {
    for (const name of sectionNames) {
      if (name !== s.current_section) {
        extras.push({
          label: `Move to section: ${name}`,
          action: () => void lifecycleArgs("move_to_section", { id: s.id, section: name }),
        });
      }
    }
    if (s.current_section) {
      extras.push({
        label: "Clear section pin",
        action: () => void lifecycleArgs("move_to_section", { id: s.id, section: null }),
      });
    }
  }

  items.push("separator", ...extras);
  return items;
}

/** Inline rename input shown in place of the row's title. */
function renderRenameInput(s: SessionRow): HTMLInputElement {
  const input = noTextAssist(document.createElement("input"));
  input.className = "rename-input";
  input.value = s.title;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      renamingId = null;
      renderSidebar();
    }
    if (e.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      renamingId = null;
      // Optimistic: show the new title immediately; the mask clears once a
      // snapshot carries the new title (see applyPendingOverlays).
      pendingTitles.set(s.id, title);
      s.title = title;
      invoke("rename_session", { id: s.id, title })
        .then(() => refreshNow())
        .catch((err) => {
          pendingTitles.delete(s.id); // failed: un-mask so the old title returns
          toast(`rename failed: ${err}`, "error");
          void refreshNow();
        });
      renderSidebar();
    }
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}

function renderSessionRow(s: SessionRow): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "session-row";
  // Option in the #sessions listbox: keyboard cursor is tracked by the
  // container's aria-activedescendant (updateSelectionClasses), so the row
  // needs a stable DOM id and the option role. aria-selected + aria-label are
  // set from state in updateRow.
  row.id = `row-${s.id}`;
  row.setAttribute("role", "option");
  if (s.stacked_child) row.classList.add("stacked");

  const main = document.createElement("div");
  main.className = "row-main";

  const refs: RowRefs = { row, main, actions: buildActions(s), status: s.status, session: s };
  rowRefs.set(s.id, refs);

  if (renamingId === s.id) {
    main.appendChild(renderRenameInput(s));
    row.append(main, refs.actions);
    return row;
  }

  row.append(main); // actions land inside main's sub-line via fillRowMain
  row.addEventListener("click", () => {
    selectRow(refs.session.id);
    void openTerminal(refs.session);
  });
  row.addEventListener("contextmenu", (e) => showContextMenu(e, sessionMenuItems(refs)));
  // Draggable onto a section header to re-pin the session (section view only;
  // headers are annotated with dataset.dropSection in renderSections). Not wired
  // in rename mode: that branch returns above.
  row.dataset.id = s.id;
  draggable(row, () => {
    row.classList.add("dragging");
    return {
      onMove(x, y) {
        clearDropTargets();
        const header = document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-header");
        if (header?.dataset.dropSection !== undefined) header.classList.add("drop-target");
      },
      onDrop(x, y) {
        const header = document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-header");
        if (header?.dataset.dropSection === undefined) return;
        // dropSection is "" on the index-0 "In Progress" catch-all: clear the pin.
        const target = header.dataset.dropSection || null;
        const id = refs.session.id;
        if ((findSession(id)?.current_section ?? null) === target) return; // no-op drop
        void lifecycleArgs("move_to_section", { id, section: target });
      },
      onEnd() {
        row.classList.remove("dragging");
        clearDropTargets();
      },
    };
  });
  updateRow(refs, s);
  return row;
}

type StackUnit =
  | { kind: "single"; session: SessionRow }
  | { kind: "stack"; parent: SessionRow; children: SessionRow[] };

/** Infer cascade stacks from an ordered row list: a non-stacked parent followed
 *  by its consecutive `stacked_child` rows forms one stack (the backend keeps a
 *  stack root + its children contiguous). Children with no preceding parent
 *  (can't happen within one project, but guard anyway) fall back to singles. */
function groupStacks(rows: SessionRow[]): StackUnit[] {
  const units: StackUnit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    if (s.stacked_child) {
      units.push({ kind: "single", session: s }); // orphan child — render flat
      continue;
    }
    const children: SessionRow[] = [];
    while (i + 1 < rows.length && rows[i + 1].stacked_child) {
      children.push(rows[++i]);
    }
    units.push(children.length ? { kind: "stack", parent: s, children } : { kind: "single", session: s });
  }
  return units;
}

/** A cascade stack: bordered group (faint mauve tint) with a header carrying the
 *  stack name (parent title) and merge/push/⋯ actions, then the parent +
 *  indented child rows (each child gets a project-color left border). */
function renderStack(parent: SessionRow, children: SessionRow[]): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = `stack ${projClass(parent.project_id)}`;

  const header = document.createElement("div");
  header.className = "stack-header";
  // The ⌗ glyph becomes the labeled "⌗ Stack of N" chip (parent + children),
  // then the parent title names which stack this is.
  const chip = stackChip(children.length + 1, "Cascade stack");
  const name = document.createElement("span");
  name.className = "stack-name";
  name.textContent = parent.title;
  name.title = parent.title;
  header.append(chip, name);

  const actions = document.createElement("span");
  actions.className = "stack-actions";
  const merge = actionButton("⛙", "Cascade-merge main → stack", () =>
    void invokeToast("cascade_merge", { id: parent.id }),
  );
  merge.classList.add("stack-merge");
  const push = actionButton("↑", "Push stack to origin", () =>
    void invokeToast("push_stack", { id: parent.id }),
  );
  push.classList.add("stack-push");
  // ⋯ opens the session menu (resume/abandon live there, gated on cascade_paused)
  // positioned at the click; can't reuse actionButton, which swallows the event.
  const more = document.createElement("button");
  more.className = "row-action";
  more.textContent = "⋯";
  more.title = "Stack actions";
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const refs = rowRefs.get(parent.id);
    if (refs) showContextMenu(e, sessionMenuItems(refs));
  });
  actions.append(merge, push, more);
  header.append(actions);

  wrap.append(header, renderSessionRow(parent));
  for (const c of children) wrap.append(renderSessionRow(c));
  return wrap;
}

/** Drop the section-header highlight from any header still showing it. */
function clearDropTargets(): void {
  for (const el of sessionsEl.querySelectorAll(".project-header.drop-target")) {
    el.classList.remove("drop-target");
  }
}

/** Refresh a row's dynamic bits without rebuilding it (preserves hover/confirm state). */
function updateRow(refs: RowRefs, s: SessionRow): void {
  refs.session = s;
  if (renamingId === s.id) return; // don't clobber the rename input
  if (refs.status !== s.status) {
    refs.actions = buildActions(s);
    refs.status = s.status;
  }
  fillRowMain(refs.main, s, refs.actions);
  refs.row.classList.toggle("active", s.tmux_session_name === activeTerm);
  refs.row.classList.toggle("attached", terminals.has(s.tmux_session_name));
  const sel = s.id === selectedId;
  refs.row.classList.toggle("selected", sel);
  refs.row.setAttribute("aria-selected", sel ? "true" : "false");
  refs.row.setAttribute("aria-label", `${s.title} — ${sessionStateWord(s, sessionStateKey(s))}`);
  if (sel) sessionsEl.setAttribute("aria-activedescendant", refs.row.id);
}

/** Launch a new session in a project, remembering the chosen harness (if any)
 *  and refreshing once the backend responds. Shared by both create entry points. */
function startSession(group: ProjectGroup, title: string, program: string | undefined): void {
  if (program) rememberHarness(group.repo_path, program);
  invoke("create_session", { projectPath: group.repo_path, title, program })
    .catch((err) => toast(`create failed: ${err}`, "error"))
    .finally(() => void refreshNow());
}

function renderCreateInput(group: ProjectGroup): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "create-input";
  const row = document.createElement("div");
  row.className = "create-input-row";
  const input = noTextAssist(document.createElement("input"));
  input.placeholder = "new session title…";
  const picker = createHarnessPicker(group.repo_path);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // A stray keypress while the harness menu is open closes it, not the input.
      if (picker.isOpen()) {
        picker.closeMenu();
        return;
      }
      newSessionProject = null;
      renderSidebar();
    }
    if (e.key === "ArrowDown" && !picker.isOpen()) {
      e.preventDefault();
      picker.openMenu();
    }
    if (e.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      const program = picker.selected() || undefined;
      picker.closeMenu(); // drop the picker's document listener before the re-render
      newSessionProject = null;
      input.disabled = true;
      startSession(group, title, program);
    }
  });
  row.append(input, picker.element);
  wrap.appendChild(row);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

let sidebarSignature = "";

/**
 * Rebuild the sidebar DOM only when its structure (projects, session set/order,
 * open create-input) changes; otherwise patch rows in place. A periodic full
 * rebuild would wipe the create-input text and confirm-button state every tick.
 */
function projectMenuItems(group: ProjectGroup, createKey: string = group.id): MenuItem[] {
  return [
    {
      label: "New session…",
      shortcut: kb("new_session"),
      action: () => {
        newSessionProject = createKey;
        renderSidebar();
      },
    },
    { label: "Project shell", action: () => void openProjectShell(group) },
    "separator",
    {
      label: "Remove project (deletes all its sessions)",
      danger: true,
      shortcut: kb("remove_project"),
      action: () => {
        void confirmDialog(
          `Remove project "${group.name}" and all ${group.sessions.length} session(s)?\nWorktrees and tmux sessions will be removed.`,
          "Remove",
        ).then((ok) => {
          if (ok) void lifecycle("remove_project", group.id);
        });
      },
    },
  ];
}

/** Longest common prefix of a list of strings (drives Tab completion). */
function longestCommonPrefix(strings: string[]): string {
  if (!strings.length) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (prefix && !s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

/** Path input at the top of the sidebar for add-project / scan-directory, with
 *  a live directory-completion dropdown (Tab → common prefix, ↑/↓ to pick,
 *  Enter on a match drills in, Enter on free text commits) and a native folder
 *  picker via "Browse…". Seeded with `~/` so the first listing shows $HOME. */
function renderTopInput(mode: "add" | "scan"): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "create-input path-input";
  const row = document.createElement("div");
  row.className = "path-input-row";
  const input = noTextAssist(document.createElement("input"));
  input.placeholder = mode === "add" ? "path to git repo…" : "directory to scan for repos…";
  input.value = "~/";
  const browse = document.createElement("button");
  browse.className = "path-browse";
  browse.textContent = "Browse…";
  const listEl = document.createElement("div");
  listEl.className = "path-completions";
  row.append(input, browse);
  wrap.append(row, listEl);

  let completions: string[] = [];
  let selected = -1; // -1 = nothing highlighted (Enter commits the typed value)
  let debounce: number | undefined;

  function renderCompletions(): void {
    listEl.innerHTML = "";
    completions.forEach((c, i) => {
      const r = document.createElement("div");
      r.className = "path-completion";
      r.classList.toggle("selected", i === selected);
      r.textContent = c;
      // mousedown (not click) so the pick lands before the input's blur.
      r.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = `${c}/`;
        selected = -1;
        void refresh();
        input.focus();
      });
      listEl.appendChild(r);
    });
  }

  async function refresh(): Promise<void> {
    let next: string[];
    try {
      next = await invoke<string[]>("complete_path", { partial: input.value });
    } catch {
      next = [];
    }
    completions = next;
    selected = completions.length ? Math.min(selected, completions.length - 1) : -1;
    renderCompletions();
  }

  function commit(path: string): void {
    topInput = null;
    input.disabled = true;
    const call =
      mode === "add"
        ? invoke("add_project", { path })
        : invoke<{ added: number; skipped: number }>("scan_directory", { path }).then((r) =>
            toast(`Scan complete: ${r.added} added, ${r.skipped} already present`),
          );
    call
      .catch((err) => toast(`${mode === "add" ? "add project" : "scan"} failed: ${err}`, "error"))
      .finally(() => void refreshNow());
    renderSidebar();
  }

  input.addEventListener("input", () => {
    selected = -1;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void refresh(), 100);
  });

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      topInput = null;
      renderSidebar();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (completions.length) {
        selected = (selected + 1) % completions.length;
        renderCompletions();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (completions.length) {
        selected = selected <= 0 ? completions.length - 1 : selected - 1;
        renderCompletions();
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const lcp = longestCommonPrefix(completions);
      if (lcp && lcp.length > input.value.length) {
        input.value = lcp;
        void refresh();
      }
      return;
    }
    if (e.key === "Enter") {
      // A highlighted row drills into that directory; otherwise commit the
      // typed path (the "I typed the full path, just add it" case).
      if (selected >= 0 && completions[selected]) {
        input.value = `${completions[selected]}/`;
        selected = -1;
        void refresh();
      } else if (input.value.trim()) {
        commit(input.value.trim());
      }
    }
  });

  browse.addEventListener("click", () => {
    void openFolderDialog({ directory: true }).then((picked) => {
      if (typeof picked === "string") {
        input.value = picked;
        input.focus();
        void refresh();
      }
    });
  });

  setTimeout(() => {
    input.focus();
    void refresh();
  }, 0);
  return wrap;
}

async function deleteMergedSessions(): Promise<void> {
  let merged: [string, string][];
  try {
    merged = await invoke<[string, string][]>("merged_pr_sessions");
  } catch (e) {
    toast(`failed to list merged sessions: ${e}`, "error");
    return;
  }
  if (!merged.length) {
    toast("No sessions with merged PRs");
    return;
  }
  const preview = merged
    .slice(0, 8)
    .map(([, branch]) => `  • ${branch}`)
    .join("\n");
  const more = merged.length > 8 ? `\n  … and ${merged.length - 8} more` : "";
  const ok = await confirmDialog(
    `Delete ${merged.length} session(s) with merged PRs?\n\n${preview}${more}\n\nThis removes their worktrees and branches.`,
    "Delete all",
  );
  if (!ok) return;
  for (const [id] of merged) {
    const row = findSession(id);
    if (row) {
      deleteSession(row);
    } else {
      await invoke("delete_session", { id }).catch((e) => toast(`delete failed: ${e}`, "error"));
    }
  }
}

function sidebarMenuItems(): MenuItem[] {
  return [
    {
      label: "Add project…",
      shortcut: kb("new_project"),
      action: () => {
        topInput = "add";
        renderSidebar();
      },
    },
    {
      label: "Scan directory for repos…",
      shortcut: kb("scan_directory"),
      action: () => {
        topInput = "scan";
        renderSidebar();
      },
    },
    "separator",
    { label: "Settings…", shortcut: kb("show_settings"), action: () => void openSettings() },
    { label: "Help", shortcut: kb("show_help"), action: toggleHelp },
    "separator",
    {
      label: "Delete merged-PR sessions…",
      danger: true,
      shortcut: kb("delete_merged_pr_sessions"),
      action: () => void deleteMergedSessions(),
    },
  ];
}

/** Project list for the sidebar "New session…" picker. Sourced from `groups`,
 *  so it includes projects with no sessions — the one path to create a session
 *  for them in section views, where sessionless projects have no sub-header. */
function projectPickerItems(): MenuItem[] {
  if (!groups.length) {
    return [{ label: "No projects — add one first", action: () => {} }];
  }
  return groups.map((g) => ({
    label: g.name,
    action: () => void createSessionInProject(g),
  }));
}

async function createSessionInProject(group: ProjectGroup): Promise<void> {
  const result = await createSessionDialog(`New session in ${group.name}`, group.repo_path);
  if (!result) return;
  startSession(group, result.title, result.program || undefined);
}

function cycleViewMode(): void {
  if (statusGrouping) {
    // Status (GUI-only) is the cycle's last stop; leaving it restarts the
    // backend cycle at "project".
    setStatusGrouping(false);
    invoke("set_view_mode", { mode: "project" })
      .then(() => refreshNow())
      .catch((e) => toast(`${e}`, "error"));
    return;
  }
  if (viewMode === "section_stacks") {
    setStatusGrouping(true);
    return;
  }
  const order = ["project", "sections", "section_stacks"];
  const next = order[(order.indexOf(viewMode) + 1) % order.length];
  invoke("set_view_mode", { mode: next })
    .then(() => refreshNow())
    .catch((e) => toast(`${e}`, "error"));
}

/** Switch grouping to an explicit mode (the GROUP BY segmented control).
 *  viewMode is backend-owned — never set locally — so we round-trip through
 *  set_view_mode and let the next snapshot reflect it (mirror cycleViewMode). */
function setViewMode(mode: string): void {
  setStatusGrouping(false); // leaving the GUI-only Status override, if it's on
  if (mode === viewMode) return;
  invoke("set_view_mode", { mode })
    .then(() => refreshNow())
    .catch((e) => toast(`${e}`, "error"));
}

/** GROUP BY segmented control: [Sections | Projects | Status]. Sections and
 *  Projects are bound to the backend viewMode (Projects→"project",
 *  Sections→"sections"; "section_stacks" still counts as the Sections side and
 *  stays reachable via the palette's cycleViewMode). Status is the GUI-only
 *  tier grouping and overrides whichever backend mode sits underneath. */
function renderGroupByBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "group-by-bar";
  const label = document.createElement("span");
  label.className = "group-by-label";
  label.textContent = "GROUP BY";

  const seg = document.createElement("div");
  seg.className = "segmented";
  const sectionsActive = !statusGrouping && (viewMode === "sections" || viewMode === "section_stacks");

  const sectionsBtn = document.createElement("button");
  sectionsBtn.className = "segment";
  sectionsBtn.textContent = "Sections";
  sectionsBtn.classList.toggle("active", sectionsActive);
  sectionsBtn.addEventListener("click", () => setViewMode("sections"));

  const projectsBtn = document.createElement("button");
  projectsBtn.className = "segment";
  projectsBtn.textContent = "Projects";
  projectsBtn.classList.toggle("active", !statusGrouping && !sectionsActive);
  projectsBtn.addEventListener("click", () => setViewMode("project"));

  const statusBtn = document.createElement("button");
  statusBtn.className = "segment";
  statusBtn.textContent = "Status";
  statusBtn.classList.toggle("active", statusGrouping);
  statusBtn.addEventListener("click", () => setStatusGrouping(true));

  seg.append(sectionsBtn, projectsBtn, statusBtn);
  bar.append(label, seg);
  return bar;
}

/** Banner shown when a project filter is active, with a clear affordance. */
function renderFilterBanner(group: ProjectGroup): HTMLElement {
  const banner = document.createElement("div");
  banner.className = "filter-banner";
  const square = document.createElement("span");
  square.className = `proj-square ${projClass(group.id)}`;
  const text = document.createElement("span");
  text.className = "filter-text";
  text.textContent = `filtered to ${group.name}`;
  const clear = document.createElement("button");
  clear.className = "row-action";
  clear.textContent = "✕";
  clear.title = "Clear project filter";
  clear.addEventListener("click", () => {
    projectFilter = null;
    renderSidebar();
  });
  banner.append(square, text, clear);
  return banner;
}

/** Render section-grouped views: section headers with rows looked up by id. */
function renderSections(buckets: SectionBucket[]): void {
  const projById = new Map(groups.map((g) => [g.id, g]));
  buckets.forEach((bucket, bucketIndex) => {
    // Compose with the project filter: only the filtered project's ids survive.
    const ids = projectFilter
      ? bucket.session_ids.filter((id) => findSession(id)?.project_id === projectFilter)
      : bucket.session_ids;
    const header = document.createElement("div");
    header.className = "project-header";
    const name = document.createElement("span");
    name.textContent = bucket.name;
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(ids.length);
    header.append(name, count, headerRule());
    const isCollapsed = makeCollapsible(header, name, `sect:${bucket.name}`);
    // Annotate as a session drop target for the row drag (see renderRow): "" on
    // the index-0 "In Progress" catch-all clears the pin, else the section name.
    header.dataset.dropSection = bucketIndex === 0 ? "" : bucket.name;
    sessionsEl.appendChild(header);
    if (isCollapsed) return;

    // Cluster the section's sessions by project, preserving first-seen project
    // order and within-project order — a stack never spans projects, so its
    // root and indented children stay contiguous.
    const order: string[] = [];
    const byProject = new Map<string, SessionRow[]>();
    for (const id of ids) {
      const s = findSession(id);
      if (!s) continue;
      let rows = byProject.get(s.project_id);
      if (!rows) {
        rows = [];
        byProject.set(s.project_id, rows);
        order.push(s.project_id);
      }
      rows.push(s);
    }

    for (const pid of order) {
      const rows = byProject.get(pid)!;
      const group = projById.get(pid);
      if (group) {
        sessionsEl.appendChild(renderProjectSubheader(group, bucket.name));
        if (newSessionProject === sectionCreateKey(bucket.name, group.id)) {
          sessionsEl.appendChild(renderCreateInput(group));
        }
      }
      renderRows(rows);
      visibleGroups.push(rows.map((s) => s.id));
    }
  });
}

/** A project sub-header shown inside a section bucket: names the project and
 *  carries the same new-session affordances as the real project header. Not a
 *  drop target — only section headers accept dropped sessions. */
function renderProjectSubheader(group: ProjectGroup, sectionName: string): HTMLDivElement {
  const key = sectionCreateKey(sectionName, group.id);
  const header = document.createElement("div");
  header.className = "project-subheader";
  const name = document.createElement("span");
  name.textContent = group.name;
  const add = document.createElement("button");
  add.className = "row-action";
  add.textContent = "+";
  add.title = "New session in this project";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    newSessionProject = newSessionProject === key ? null : key;
    renderSidebar();
  });
  const buttons = document.createElement("span");
  buttons.className = "header-buttons";
  buttons.append(add);
  header.append(name, buttons);
  header.addEventListener("contextmenu", (e) =>
    showContextMenu(e, projectMenuItems(group, key)),
  );
  return header;
}

function renderSidebar(): void {
  const signature =
    groups
      .map((g) => `${g.id}@${g.pull_blocked}:${g.sessions.map((s) => s.id).join(",")}`)
      .join("|") +
    `#${newSessionProject}#${renamingId}#${topInput}#${viewMode}#${projectFilter}` +
    `#${sections?.map((b) => `${b.name}=${b.session_ids.join(",")}`).join("|") ?? ""}` +
    // Status grouping: tier membership must force a rebuild (a status flip has
    // to move the row between tiers, which updateRow alone can't do).
    `#${statusGrouping ? "status:" + groups.flatMap((g) => g.sessions.map((s) => `${s.id}=${sessionTier(s)}`)).join(",") : ""}` +
    `#${[...collapsed].sort().join(",")}`;

  if (signature === sidebarSignature) {
    for (const group of groups) {
      for (const s of group.sessions) {
        const refs = rowRefs.get(s.id);
        if (refs) updateRow(refs, s);
      }
    }
    return;
  }

  sidebarSignature = signature;
  rowRefs.clear();
  visibleGroups = [];
  sessionsEl.innerHTML = "";
  if (topInput) {
    sessionsEl.appendChild(renderTopInput(topInput));
  }

  // Grouping control, shown in every view.
  sessionsEl.appendChild(renderGroupByBar());

  // When a project filter is active, show a banner with a clear affordance.
  const filterGroup = projectFilter ? groups.find((g) => g.id === projectFilter) : undefined;
  if (filterGroup) {
    sessionsEl.appendChild(renderFilterBanner(filterGroup));
  }

  // The GUI-only Status grouping overrides whichever backend mode is active.
  if (statusGrouping) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderStatusTiers();
    return;
  }

  if (sections) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderSections(sections);
    return;
  }

  for (const group of groups) {
    if (projectFilter && group.id !== projectFilter) continue;
    const header = document.createElement("div");
    header.className = "project-header";
    const square = document.createElement("span");
    square.className = `proj-square ${projClass(group.id)}`;
    const name = document.createElement("span");
    name.textContent = group.name;
    // ⚠ pull-blocked chip sits beside the name (its own header child so it gets
    // the row gap and escapes the header's uppercase transform).
    const blockedChip = group.pull_blocked
      ? pullBlockedChip(`Auto-pull of main blocked: ${group.pull_blocked}`)
      : null;
    const buttons = document.createElement("span");
    buttons.className = "header-buttons";
    const shell = document.createElement("button");
    shell.className = "row-action";
    shell.textContent = "$";
    shell.title = "Project shell";
    shell.addEventListener("click", (e) => {
      e.stopPropagation();
      void openProjectShell(group);
    });
    const add = document.createElement("button");
    add.className = "row-action";
    add.textContent = "+";
    add.title = "New session in this project";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      newSessionProject = newSessionProject === group.id ? null : group.id;
      collapsed.delete(`proj:${group.id}`); // the create input must be visible
      renderSidebar();
    });
    buttons.append(shell, add);
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(group.sessions.length);
    header.append(square, name, count);
    if (blockedChip) header.append(blockedChip);
    header.append(headerRule(), buttons);
    const isCollapsed = makeCollapsible(header, name, `proj:${group.id}`);
    header.addEventListener("contextmenu", (e) => showContextMenu(e, projectMenuItems(group)));
    sessionsEl.appendChild(header);
    if (isCollapsed) continue;

    if (newSessionProject === group.id) {
      sessionsEl.appendChild(renderCreateInput(group));
    }
    if (!group.sessions.length && projectFilter === group.id) {
      sessionsEl.appendChild(renderEmptyProject(group));
      continue;
    }
    renderRows(group.sessions);
    visibleGroups.push(group.sessions.map((s) => s.id));
  }
}

/** Full-width create button for groupings without project headers (section and
 *  status views): pick any project (incl. sessionless ones), then a title. */
function renderNewSessionButton(): HTMLButtonElement {
  const newBtn = document.createElement("button");
  newBtn.className = "new-session-btn";
  newBtn.textContent = "+ New session";
  newBtn.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));
  return newBtn;
}

/** Render the GUI-only Status grouping: sessions bucketed into coarse activity
 *  tiers (Needs you / Active / Parked; see stateTier). Tier membership only
 *  changes on meaningful events — a turn ending, a session stopped or resumed —
 *  never on the working ⇄ idle flicker, so rows don't shuffle underneath the
 *  user. Within a tier, rows cluster by project in snapshot order (mirroring
 *  renderSections). Empty tiers are hidden. Tier headers are not section drop
 *  targets: status changes machine-side, so there's nothing to drag onto. */
function renderStatusTiers(): void {
  const buckets = new Map<StatusTier, SessionRow[]>();
  for (const g of groups) {
    if (projectFilter && g.id !== projectFilter) continue;
    for (const s of g.sessions) {
      const tier = sessionTier(s);
      let rows = buckets.get(tier);
      if (!rows) {
        rows = [];
        buckets.set(tier, rows);
      }
      rows.push(s);
    }
  }

  const projById = new Map(groups.map((g) => [g.id, g]));
  for (const { tier, label } of STATUS_TIERS) {
    const tierRows = buckets.get(tier);
    if (!tierRows?.length) continue;
    const header = document.createElement("div");
    // tier-* lets the "Needs you" tier read as the list's peak (see CSS); the
    // other tiers keep the plain group-header treatment.
    header.className = `project-header tier-${tier}`;
    const name = document.createElement("span");
    name.textContent = label;
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = String(tierRows.length);
    header.append(name, count, headerRule());
    const isCollapsed = makeCollapsible(header, name, `tier:${tier}`);
    sessionsEl.appendChild(header);
    if (isCollapsed) continue;

    // Cluster the tier's sessions by project, preserving snapshot order.
    const order: string[] = [];
    const byProject = new Map<string, SessionRow[]>();
    for (const s of tierRows) {
      let rows = byProject.get(s.project_id);
      if (!rows) {
        rows = [];
        byProject.set(s.project_id, rows);
        order.push(s.project_id);
      }
      rows.push(s);
    }

    for (const pid of order) {
      const rows = byProject.get(pid)!;
      const group = projById.get(pid);
      if (group) {
        sessionsEl.appendChild(renderProjectSubheader(group, label));
        if (newSessionProject === sectionCreateKey(label, group.id)) {
          sessionsEl.appendChild(renderCreateInput(group));
        }
      }
      renderRows(rows);
      visibleGroups.push(rows.map((s) => s.id));
    }
  }
}

/** Render an ordered row list, folding consecutive stacked_child rows into a
 *  bordered stack group. Shared by both groupings. */
function renderRows(rows: SessionRow[]): void {
  for (const unit of groupStacks(rows)) {
    if (unit.kind === "stack") {
      sessionsEl.appendChild(renderStack(unit.parent, unit.children));
    } else {
      sessionsEl.appendChild(renderSessionRow(unit.session));
    }
  }
}

/** Empty-project state shown when filtered to a project with no sessions: a
 *  dashed "＋" tile plus new-session / shell affordances (reusing the rail's
 *  backend wiring). */
function renderEmptyProject(group: ProjectGroup): HTMLDivElement {
  const block = document.createElement("div");
  block.className = "empty-project";
  const tile = document.createElement("div");
  tile.className = "empty-tile";
  tile.textContent = "＋";
  const msg = document.createElement("div");
  msg.className = "empty-msg";
  msg.textContent = `No sessions in ${group.name} yet`;
  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const create = document.createElement("button");
  create.className = "row-action";
  create.textContent = "＋ New session";
  create.addEventListener("click", () => void createSessionInProject(group));
  const shell = document.createElement("button");
  shell.className = "row-action";
  shell.textContent = "$ Shell";
  shell.addEventListener("click", () => void openProjectShell(group));
  actions.append(create, shell);
  block.append(tile, msg, actions);
  return block;
}

document.querySelector<HTMLButtonElement>("#sidebar-menu")!.addEventListener("click", (e) => {
  showContextMenu(e, sidebarMenuItems());
});

// ------------------------------------------------------------- onboarding
//
// First-run hero over the terminal pane. Shown whenever there are zero
// projects AND no terminal is attached — attaching one (e.g. via the hero's
// own commander CTA) must yield the hero, not leave it rendered on top of
// the freshly attached terminal (see updatePlaceholder). No persisted flag;
// purely driven by the live snapshot (applySnapshot) and terminal attach/detach.

const onboardingEl = document.querySelector<HTMLDivElement>("#onboarding")!;
const onboardingAddProjectBtn = document.querySelector<HTMLButtonElement>("#onboarding-add-project")!;
const onboardingCommanderBtn = document.querySelector<HTMLButtonElement>("#onboarding-commander")!;
let commanderEnabled = false; // mirrors renderCommander's gate; set in applySnapshot

/** First-run hero state: no projects and nothing attached. */
function onboardingActive(): boolean {
  return groups.length === 0 && terminals.size === 0;
}

function renderOnboarding(): void {
  const show = onboardingActive();
  const wasShown = !onboardingEl.classList.contains("hidden");
  onboardingEl.classList.toggle("hidden", !show);
  // Board layout hides #terminal-pane, which hosts the hero — so a persisted
  // Board layout (or deleting the last project while on the Board) would show
  // a blank surface instead of first-run guidance. Yield to Console while the
  // hero is up; the Board segment is guarded below for the same reason.
  if (show && layout === "board") setLayout("console");
  // Card 3 is only a live control when the commander is actually configured —
  // otherwise it reads inert, like card 2's "After a project" placeholder,
  // rather than firing prepare_commander into a raw error toast.
  onboardingCommanderBtn.disabled = !commanderEnabled;
  onboardingCommanderBtn.classList.toggle("outline", commanderEnabled);
  onboardingCommanderBtn.classList.toggle("muted", !commanderEnabled);
  // On first show, focus the primary path so Enter fires "Choose folder…"
  // (the ⏎-hinted CTA) rather than nothing — card 3's commander button is
  // disabled here, so it must never be the implicit Enter target.
  if (show && !wasShown) onboardingAddProjectBtn.focus();
}

onboardingAddProjectBtn.addEventListener("click", () => {
  // Same native folder-picker the sidebar's Browse… uses; a cancel (no path
  // picked) falls back to revealing the sidebar's path input so they can
  // type it instead.
  void openFolderDialog({ directory: true }).then((picked) => {
    if (typeof picked === "string") {
      const name = picked.replace(/\/+$/, "").split("/").pop() || picked;
      invoke("add_project", { path: picked })
        .then(() => toast(`Added ${name}.`))
        .catch((err) => actionErrorToast("add_project", err))
        .finally(() => void refreshNow());
    } else {
      topInput = "add";
      renderSidebar();
    }
  });
});

onboardingCommanderBtn.addEventListener("click", () => commanderChip.click());

// ----------------------------------------------------------------- title bar

const appEl = document.querySelector<HTMLElement>("#app")!;
const boardEl = document.querySelector<HTMLElement>("#board")!;
const boardFilterEl = document.querySelector<HTMLDivElement>("#board-filter")!;
const boardColumnsEl = document.querySelector<HTMLDivElement>("#board-columns")!;
const boardDockEl = document.querySelector<HTMLDivElement>("#board-dock")!;
const boardDockSurfaceEl = document.querySelector<HTMLDivElement>("#board-dock-surface")!;
const boardDockPlaceholderEl = document.querySelector<HTMLDivElement>("#board-dock-placeholder")!;
const boardDockNameEl = document.querySelector<HTMLSpanElement>("#board-dock-name")!;
const boardDockBranchEl = document.querySelector<HTMLSpanElement>("#board-dock-branch")!;
const tbCount = document.querySelector<HTMLElement>("#tb-count")!;
const tbAttention = document.querySelector<HTMLElement>("#tb-attention")!;
// The board's mirror of the attention pill; created with the filter bar.
let boardAttentionEl: HTMLSpanElement | null = null;
const tbConsole = document.querySelector<HTMLButtonElement>("#tb-console")!;
const tbBoard = document.querySelector<HTMLButtonElement>("#tb-board")!;

/** Sessions waiting on the user: the agent asked for input, or finished while
 *  away (unread) — the at-a-glance attention queue, in sidebar snapshot order.
 *  In lockstep with the status-chip vocabulary via sessionStateKey. */
function attentionSessions(): SessionRow[] {
  return groups.flatMap((g) => g.sessions).filter((s) => {
    const key = sessionStateKey(s);
    return key === "waiting" || key === "finished";
  });
}

function attentionCount(): number {
  return attentionSessions().length;
}

/** Jump to the next session that needs the user — select it and open its
 *  terminal — cycling through the attention queue on repeat activation, so the
 *  "N waiting on you" pill doubles as a one-key sweep of everything blocked on
 *  you. No-op when nothing waits. */
function jumpToAttention(): void {
  const queue = attentionSessions();
  if (!queue.length) return;
  const cur = selectedId ? queue.findIndex((s) => s.id === selectedId) : -1;
  const next = queue[(cur + 1) % queue.length];
  setLayout("console");
  selectRow(next.id);
  void openTerminal(next);
}

function updateTitleBarCounts(): void {
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const live = groups.flatMap((g) => g.sessions).filter((s) => s.status === "running").length;
  tbCount.textContent = `${total} sessions · ${live} live`;
  const waiting = attentionCount();
  tbAttention.textContent = `${waiting} waiting on you`;
  tbAttention.classList.toggle("hidden", waiting === 0);
  if (boardAttentionEl) {
    boardAttentionEl.textContent = `${waiting} waiting on you`;
    boardAttentionEl.classList.toggle("hidden", waiting === 0);
  }
}

/** Make an attention pill actionable: click or Enter/Space jumps to the next
 *  session that needs you (see jumpToAttention). The title-bar markup already
 *  carries role/tabindex/aria-live; the board mirror gets them here. */
function wireAttentionPill(el: HTMLElement): void {
  el.addEventListener("click", jumpToAttention);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      jumpToAttention();
    }
  });
}
wireAttentionPill(tbAttention);

function setLayout(next: "console" | "board"): void {
  if (next === layout) return;
  // Split lives only in console. Collapse it (keeping the focused pane) while
  // the DOM is still in console layout, before switching surfaces.
  if (splitActive()) exitSplit(focusedSlot ? panes.get(focusedSlot)! : activeTerm);
  layout = next;
  localStorage.setItem("cc-layout", next);
  closeReview();
  appEl.classList.toggle("board-mode", next === "board");
  boardEl.classList.toggle("hidden", next !== "board");
  tbConsole.classList.toggle("active", next === "console");
  tbBoard.classList.toggle("active", next === "board");
  // Re-parent the active terminal into/out of the dock now that the target
  // surface is visible, then fit it (dock/undock fit internally).
  if (next === "board") {
    dockDetached = false; // a fresh board entry re-docks the active terminal
    dockActiveTerminal();
  } else {
    setDockFullscreen(false);
    undockTerminal();
  }
}

tbConsole.addEventListener("click", () => setLayout("console"));
tbBoard.addEventListener("click", () => {
  // The Board has nothing to show before the first project — keep the hero
  // (which lives in the Console's terminal pane) instead of a blank surface.
  if (onboardingActive()) {
    toast("Add a project first — the Board shows your sessions.");
    return;
  }
  setLayout("board");
});
document.querySelector<HTMLButtonElement>("#tb-jump")!.addEventListener("click", () => togglePalette());
document
  .querySelector<HTMLButtonElement>("#tb-theme")!
  .addEventListener("click", () => openThemeModal(currentTheme().appearance));
document.querySelector<HTMLButtonElement>("#tb-help")!.addEventListener("click", () => toggleHelp());

// Initialize segment + board visibility from persisted layout.
appEl.classList.toggle("board-mode", layout === "board");
boardEl.classList.toggle("hidden", layout !== "board");
tbConsole.classList.toggle("active", layout === "console");
tbBoard.classList.toggle("active", layout === "board");
// Dock the active terminal (if any) when booting straight into board mode.
if (layout === "board") dockActiveTerminal();

// Dock "×" closes the preview: undock the terminal back to #terminals and
// collapse the whole dock panel so the columns fill the board. It does NOT kill
// the PTY — the session stays attached and the terminal reappears in Console
// (or on the next card ▸, which reopens the dock). Also drops out of the
// fullscreen overlay if it was open (nothing left to show fullscreen).
document.querySelector<HTMLButtonElement>("#board-dock-close")!.addEventListener("click", () => {
  setDockFullscreen(false);
  undockTerminal();
  dockDetached = true;
  updateDockHeader();
});
// Dock "⤢": float the docked terminal into a centred ~85% overlay over a dimmed
// backdrop — obviously a dismissable dialog, not a panel that ate the window.
// Toggling clears any drag-set inline height so the overlay's CSS size wins, and
// re-fits the xterm into the new surface.
const boardDockBackdropEl = document.querySelector<HTMLDivElement>("#board-dock-backdrop")!;
function setDockFullscreen(on: boolean): void {
  boardDockEl.classList.toggle("dock-fullscreen", on);
  boardDockBackdropEl.classList.toggle("hidden", !on);
  // makeResizable sets an inline `position: relative` (+ height) on the dock, and
  // inline styles beat the overlay's stylesheet rule — so toggle them directly.
  if (on) {
    boardDockEl.style.position = "fixed";
    boardDockEl.style.height = ""; // let the overlay's CSS inset size win
  } else {
    boardDockEl.style.position = "relative";
    const saved = Number(localStorage.getItem("cc-dock-height"));
    boardDockEl.style.height = saved ? `${saved}px` : ""; // restore the resized height
  }
  if (layout === "board") dockActiveTerminal();
}
document.querySelector<HTMLButtonElement>("#board-dock-expand")!.addEventListener("click", () => {
  setDockFullscreen(!boardDockEl.classList.contains("dock-fullscreen"));
});
boardDockBackdropEl.addEventListener("click", () => setDockFullscreen(false));

// Dock vertical resize: drag the separator between the columns and the dock to
// set the dock height. Re-fits the docked xterm on each frame.
makeResizable({
  key: "cc-dock-height",
  target: boardDockEl,
  edge: "top",
  min: 120,
  max: 600,
  onResize: () => {
    if (layout === "board") dockActiveTerminal();
  },
});

// ------------------------------------------------------------ commander chip

const commanderChip = document.querySelector<HTMLElement>("#commander-chip")!;

function renderCommander(c: Snapshot["commander"]): void {
  commanderChip.classList.toggle("hidden", !c.enabled);
  if (!c.enabled) return;
  commanderChip.innerHTML = "";
  const square = document.createElement("span");
  square.className = "commander-square";
  square.title = c.running ? "running" : "stopped";
  const label = document.createElement("span");
  label.className = "commander-label";
  label.textContent = "commander";
  const attach = document.createElement("span");
  attach.className = "commander-attach";
  attach.textContent = "attach ⏎";
  commanderChip.append(square, label, attach);
}

commanderChip.addEventListener("click", () => {
  void (async () => {
    let name: string;
    try {
      name = await invoke<string>("prepare_commander");
    } catch (e) {
      toast(`commander failed: ${e}`, "error");
      return;
    }
    await attachTerminal(name, "commander", null);
  })();
});

// ------------------------------------------------------------------- board
//
// The Board layout renders the SAME snapshot `groups` as the sidebar — one
// column per project, agent cards inside — reusing the Console helpers
// (projClass / applyStatusGlyph / sessionMenuItems / openReview /
// openTerminal). Selection is shared with the sidebar via `selectedId`.

/** Card DOM refs by session id, so updateSelectionClasses can toggle the
 *  selected border without a full rebuild. Rebuilt on every renderBoard. */
const boardCardRefs = new Map<string, HTMLDivElement>();

/** Per-session diffstat cache, lazily filled from get_session_detail, keyed by
 *  id so a card keeps its bar across re-renders. `null` = fetched, no diff;
 *  absent = not yet fetched. */
const boardDiffStats = new Map<string, string | null>();
const boardDiffPending = new Set<string>();

/** Map a liveness `.dot` state class to the semantic token class the accent
 *  bar / state pill use. Keeps the board in lockstep with the dot colours
 *  without re-deriving the status logic (we read applyStatusGlyph's output). */
function boardStateClass(s: SessionRow): string {
  return `state-${sessionStateKey(s)}`; // running → state-running, in lockstep with the dot/chip mapping
}

/** Every project id known to the current snapshot, in board order. */
function allProjectIds(): string[] {
  return groups.map((g) => g.id);
}

/** The selected project ids, bounded to projects still present in the snapshot.
 *  null (the default) means every project — returned here as the full set. */
function selectedProjectIds(): Set<string> {
  const all = allProjectIds();
  return boardProjectFilter ? new Set(all.filter((id) => boardProjectFilter!.has(id))) : new Set(all);
}

/** Does a session pass the project filter? Search composes on top. */
function boardMatchesFilter(s: SessionRow): boolean {
  return !boardProjectFilter || boardProjectFilter.has(s.project_id);
}

function boardMatchesSearch(s: SessionRow): boolean {
  if (!boardSearch) return true;
  return s.title.toLowerCase().includes(boardSearch.toLowerCase());
}

/** A board column: the sessions pinned to one section (or the leading "no
 *  section" catch-all), already narrowed by filter + search. `key` is the
 *  section name, or `NO_SECTION_KEY` for the catch-all. */
type BoardSection = { key: string; name: string; sessions: SessionRow[] };

// Sentinel key for the leading catch-all column (sessions with no section pin,
// and — when no sections are configured at all — every session).
const NO_SECTION_KEY = "\x00none";
const NO_SECTION_LABEL = "No section";

/** All sessions across projects, bucketed into section columns and narrowed by
 *  the active filter + search. The catch-all "no section" column comes first,
 *  then one column per configured section in `sectionNames` order. */
function boardSectionColumns(): BoardSection[] {
  const none: BoardSection = { key: NO_SECTION_KEY, name: NO_SECTION_LABEL, sessions: [] };
  const byName = new Map<string, BoardSection>();
  const cols: BoardSection[] = [none];
  for (const name of sectionNames) {
    const col: BoardSection = { key: name, name, sessions: [] };
    byName.set(name, col);
    cols.push(col);
  }
  for (const g of groups) {
    for (const s of g.sessions) {
      if (!(boardMatchesFilter(s) && boardMatchesSearch(s))) continue;
      const sec = s.current_section;
      (sec && byName.get(sec) ? byName.get(sec)! : none).sessions.push(s);
    }
  }
  return cols;
}

/** Lazy-fetch a session's diffstat for its card bar; fill in place when it
 *  lands. Skips while a fetch is in flight or already cached. */
function ensureBoardDiffStat(id: string, bar: HTMLElement): void {
  if (boardDiffStats.has(id)) {
    fillDiffstatBar(bar, boardDiffStats.get(id) ?? null);
    return;
  }
  if (boardDiffPending.has(id)) return;
  boardDiffPending.add(id);
  invoke<SessionDetail | null>("get_session_detail", { id })
    .then((d) => {
      boardDiffStats.set(id, d?.diff_stat ?? null);
      if (bar.isConnected) fillDiffstatBar(bar, d?.diff_stat ?? null);
    })
    .catch(() => {
      /* transient — leave uncached so a later render retries */
    })
    .finally(() => boardDiffPending.delete(id));
}

/** Render a diffstat into a card's bar: colorized +adds/−dels counts above a
 *  proportional add/remove bar. Mirrors renderDetail's parsing. Omits both when
 *  there is no diff (graceful — never fabricated). */
function fillDiffstatBar(container: HTMLElement, diffStat: string | null): void {
  container.innerHTML = "";
  const stat = diffStat ? parseDiffStat(diffStat) : null;
  if (!stat || stat.adds + stat.dels === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  const counts = document.createElement("div");
  counts.className = "card-diffcounts";
  const a = document.createElement("span");
  a.className = "added";
  a.textContent = `+${stat.adds}`;
  const r = document.createElement("span");
  r.className = "removed";
  r.textContent = `−${stat.dels}`;
  counts.append(a, r);
  // Bar on top, counts below (the Refined board layout): the proportional bar
  // spans the card, then the +adds/−dels counts sit on their own line and wrap
  // rather than clipping at the column edge.
  container.append(diffstatBar(stat.adds, stat.dels), counts);
}

/** One agent card for a session. */
function renderAgentCard(s: SessionRow): HTMLDivElement {
  const card = document.createElement("div");
  // State class drives the 3px left accent border (--state-color); in lockstep
  // with the status chip's colour.
  card.className = `agent-card ${boardStateClass(s)}`;
  card.classList.toggle("selected", selectedId === s.id);
  boardCardRefs.set(s.id, card);

  // The card is the primary keyboard target: a role=button tile in the board's
  // roving-tabindex group (updateBoardRoving picks which card is tab-focusable;
  // the arrow/Enter handler on #board-columns does the rest). Enter/Space attach.
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${s.title}, ${s.project_name}`);
  card.tabIndex = -1;

  // Drag the card onto another section column to re-pin it. The move commits on
  // release over a column, so an Esc-cancelled drag is a no-op. The card's own
  // click/⋯/▸/± handlers still fire when the pointer doesn't move (no drag).
  card.dataset.id = s.id;
  draggable(card, () => {
    card.classList.add("dragging");
    return {
      onMove(x, y) {
        clearCardDropTargets();
        document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>(".board-col")
          ?.classList.add("card-drop-target");
      },
      onDrop(x, y) {
        const col = document.elementFromPoint(x, y)?.closest<HTMLElement>(".board-col");
        const key = col?.dataset.section;
        if (key === undefined) return;
        // The catch-all column clears the pin (section: null); real columns pin
        // to the section name (dataset.section === the section name).
        const target = key === NO_SECTION_KEY ? null : key;
        if ((findSession(s.id)?.current_section ?? null) === target) return; // no-op drop
        void lifecycleArgs("move_to_section", { id: s.id, section: target });
      },
      onEnd() {
        card.classList.remove("dragging");
        clearCardDropTargets();
      },
    };
  });

  // Header: a title block (session name over its project) + status chip + ⋯
  // menu. Cards now group by section, not project, so the project is named on
  // each card: the session title is primary (h1), the project secondary (h2).
  const header = document.createElement("div");
  header.className = "card-header";
  const heading = document.createElement("div");
  heading.className = "card-heading";
  const name = document.createElement("span");
  name.className = "card-title";
  name.textContent = s.title;
  // The title truncates with an ellipsis, so its tooltip restores the full
  // session name (the branch has its own tooltip on the subtitle below).
  name.title = s.title;
  const project = document.createElement("span");
  project.className = "card-project";
  const square = document.createElement("span");
  square.className = `proj-square ${projClass(s.project_id)}`;
  const projName = document.createElement("span");
  projName.className = "card-project-name";
  projName.textContent = s.project_name;
  project.append(square, projName);
  project.title = s.project_name;
  heading.append(name, project);
  const menu = document.createElement("button");
  menu.className = "row-action card-menu";
  menu.textContent = "⋯";
  menu.title = "Session menu";
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, sessionMenuItems(cardRefs(s)));
  });
  header.append(heading, menu);
  card.appendChild(header);

  // Status chip on its own row under the title — beside the title it crowded
  // long session names into early ellipsis. The 3px left accent border
  // reinforces its colour; the board uses the compact chip variant.
  const chip = sessionStatusChip(s);
  chip.classList.add("compact");
  const statusRow = document.createElement("div");
  statusRow.className = "card-status-row";
  // Non-color cue that this card's terminal is the one docked below — shown by
  // CSS only when the card is `.selected` (the board's docked session). Pairs
  // with the accent outline so the docked state survives grayscale.
  const docked = document.createElement("span");
  docked.className = "card-docked";
  docked.textContent = "▸ docked";
  statusRow.append(chip, docked);
  card.appendChild(statusRow);

  // Branch line under the title — only when it diverges from the title (it's
  // usually just a slug of the name), mirroring the sidebar row. Omitted
  // otherwise to keep cards compact. The PR badge lives in the footer.
  if (!branchMatchesTitle(s.title, s.branch)) {
    const sub = document.createElement("div");
    sub.className = "card-subtitle";
    const branch = document.createElement("span");
    branch.className = "card-branch";
    branch.textContent = s.branch;
    branch.title = `Branch: ${s.branch}`;
    sub.appendChild(branch);
    card.appendChild(sub);
  }

  // Diffstat bar (lazy; hidden until a diff lands).
  const diff = document.createElement("div");
  diff.className = "card-diffstat hidden";
  card.appendChild(diff);
  ensureBoardDiffStat(s.id, diff);

  // Footer: PR badge + ✎/⚠ chips over an always-visible action row of labeled
  // buttons — Attach (accent, the primary action) / ± Review (info). The chips
  // row collapses when empty, so cards without badges lose no vertical budget.
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const chips = document.createElement("span");
  chips.className = "card-chips";
  const prChip = prBadge(s);
  if (prChip) chips.appendChild(prChip);
  if (s.has_pending_comments) {
    chips.appendChild(commentsChip(undefined, "Has pending review comments"));
  }
  const blocked = groupOf(s.id)?.pull_blocked;
  if (blocked) {
    chips.appendChild(pullBlockedChip(`Auto-pull blocked: ${blocked}`));
  }
  const actions = document.createElement("span");
  actions.className = "card-actions";
  // Attach path shared by the ▸ button and a card-body click: select, clear any
  // prior "×" detach, and open the terminal (which docks in board mode).
  const attachCard = (): void => {
    selectRow(s.id);
    dockDetached = false; // an explicit attach re-docks even after a "×" detach
    void openTerminal(s);
  };
  const attach = document.createElement("button");
  attach.className = "card-action attach";
  attach.textContent = "Attach";
  attach.title = "Attach";
  attach.addEventListener("click", (e) => {
    e.stopPropagation();
    attachCard();
  });
  const review = document.createElement("button");
  review.className = "card-action review";
  review.textContent = "± Review";
  review.title = "Review diff";
  review.addEventListener("click", (e) => {
    e.stopPropagation();
    void openReview(s.id, s.title);
  });
  actions.append(attach, review);
  footer.append(chips, actions);
  card.appendChild(footer);

  // Click attaches (same as ▸); right-click opens the same menu as the ⋯ button.
  // The ▸/±/⋯ buttons stopPropagation, so they never double-trigger this.
  card.addEventListener("click", attachCard);
  card.addEventListener("contextmenu", (e) => showContextMenu(e, sessionMenuItems(cardRefs(s))));
  return card;
}

/** Minimal RowRefs for sessionMenuItems from a card (it reads only .session;
 *  rename routes through the sidebar, which is acceptable on the board). */
function cardRefs(s: SessionRow): RowRefs {
  return {
    row: document.createElement("div"),
    main: document.createElement("div"),
    actions: document.createElement("div"),
    status: s.status,
    session: s,
  };
}

// Board column order is GUI-owned (like theme/layout prefs): the canonical order
// is the "no section" catch-all first, then sections in their configured order.
// We re-sort client-side from a persisted key list so drag-to-reorder sticks
// across reloads without touching CC config.
const BOARD_ORDER_KEY = "cc-board-col-order";
function loadBoardOrder(): string[] {
  try {
    const raw = localStorage.getItem(BOARD_ORDER_KEY);
    return Array.isArray(JSON.parse(raw ?? "")) ? (JSON.parse(raw!) as string[]) : [];
  } catch {
    return [];
  }
}
let boardColOrder = loadBoardOrder();

/** Section columns re-sorted by the persisted column order. Columns absent from
 *  the saved order (new sections) keep their canonical position, after the
 *  ranked ones — Array.sort is stable, so unranked relative order is preserved. */
function orderedSectionColumns(): BoardSection[] {
  const rank = new Map(boardColOrder.map((key, i) => [key, i] as const));
  return [...boardSectionColumns()].sort(
    (a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity),
  );
}

/** The column to drop before, given the pointer's x (null = past the last). */
function colBeforeX(x: number): HTMLElement | null {
  const cols = [...boardColumnsEl.querySelectorAll<HTMLElement>(".board-col:not(.dragging)")];
  for (const c of cols) {
    const r = c.getBoundingClientRect();
    if (x < r.left + r.width / 2) return c;
  }
  return null;
}

/** Insertion marker, mirroring the tab strip: an accent line on the edge where
 *  the dragged column will land (left for "before", right of the last for end). */
function showColDropMarker(target: HTMLElement | null): void {
  clearColDropMarker();
  if (target) {
    target.classList.add("drop-before");
  } else {
    const cols = boardColumnsEl.querySelectorAll<HTMLElement>(".board-col:not(.dragging)");
    cols[cols.length - 1]?.classList.add("drop-after");
  }
}
function clearColDropMarker(): void {
  for (const c of boardColumnsEl.querySelectorAll(".board-col.drop-before, .board-col.drop-after")) {
    c.classList.remove("drop-before", "drop-after");
  }
}

/** Remove the card-drop highlight from every column. */
function clearCardDropTargets(): void {
  for (const c of boardColumnsEl.querySelectorAll(".board-col.card-drop-target")) {
    c.classList.remove("card-drop-target");
  }
}

// ── Board keyboard navigation ──────────────────────────────────────────────
// The board is a roving-tabindex group: exactly one card is tab-focusable, so
// Tab lands on a card; arrows then move focus across cards and columns, and
// Enter/Space attaches. Roving *focus* is distinct from *selection* — the
// `.selected`/docked card (see selectRow) — so browsing the board never docks a
// session until you press Enter.
let boardFocusId: string | null = null;

function boardCards(): HTMLDivElement[] {
  return [...boardColumnsEl.querySelectorAll<HTMLDivElement>(".agent-card")];
}

/** Give exactly one card `tabIndex 0` — the docked card if visible, else the
 *  last-focused card, else the first — so Tab enters the board on a sensible
 *  card. Called after every column rebuild. */
function updateBoardRoving(): void {
  const cards = boardCards();
  const chosen =
    (selectedId ? boardCardRefs.get(selectedId) : undefined) ??
    (boardFocusId ? boardCardRefs.get(boardFocusId) : undefined) ??
    cards[0];
  for (const c of cards) c.tabIndex = c === chosen ? 0 : -1;
  boardFocusId = chosen?.dataset.id ?? boardFocusId;
}

/** Move roving focus to `card`, updating the tabindex so it stays the entry
 *  point, then focus it. */
function focusBoardCard(card: HTMLDivElement | undefined): void {
  if (!card) return;
  for (const c of boardCards()) c.tabIndex = c === card ? 0 : -1;
  boardFocusId = card.dataset.id ?? null;
  card.focus();
}

/** Focus the card nearest `rowIdx` in the first non-empty column found stepping
 *  `dir` from `colIdx` (skips empty columns). */
function focusAdjacentColumn(
  cols: HTMLElement[],
  colIdx: number,
  dir: 1 | -1,
  rowIdx: number,
): void {
  for (let i = colIdx + dir; i >= 0 && i < cols.length; i += dir) {
    const cards = [...cols[i].querySelectorAll<HTMLDivElement>(".agent-card")];
    if (cards.length) {
      focusBoardCard(cards[Math.min(rowIdx, cards.length - 1)]);
      return;
    }
  }
}

boardColumnsEl.addEventListener("keydown", (e) => {
  const card = (e.target as HTMLElement | null)?.closest<HTMLDivElement>(".agent-card");
  // Only when the card itself holds focus — leave inner buttons (Attach/Review/⋯)
  // to their own native key handling.
  if (!card || card !== e.target) return;
  const cols = [...boardColumnsEl.querySelectorAll<HTMLElement>(".board-col")];
  const colIdx = cols.findIndex((c) => c.contains(card));
  const siblings = [
    ...(card.closest(".board-col-body")?.querySelectorAll<HTMLDivElement>(".agent-card") ?? []),
  ];
  const rowIdx = siblings.indexOf(card);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      focusBoardCard(siblings[rowIdx + 1]);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusBoardCard(siblings[rowIdx - 1]);
      break;
    case "ArrowRight":
      e.preventDefault();
      focusAdjacentColumn(cols, colIdx, 1, rowIdx);
      break;
    case "ArrowLeft":
      e.preventDefault();
      focusAdjacentColumn(cols, colIdx, -1, rowIdx);
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      card.click(); // card click === attachCard
      break;
  }
});

/** One section column: header (name + visible count) over a body of stacked
 *  agent cards. Rendered for every section incl. the "no section" catch-all. */
function renderBoardColumn(sec: BoardSection): HTMLDivElement {
  const col = document.createElement("div");
  col.className = "board-col";
  col.dataset.section = sec.key; // read by the card drag (renderAgentCard) as the drop target

  const header = document.createElement("div");
  header.className = "board-col-header";
  // Drag the header to reorder columns within the strip. The new order commits
  // on release over the strip, so an Esc-cancelled drag leaves it intact.
  draggable(header, () => {
    col.classList.add("dragging");
    return {
      onMove(x, y) {
        if (document.elementFromPoint(x, y)?.closest("#board-columns")) {
          showColDropMarker(colBeforeX(x));
        } else {
          clearColDropMarker();
        }
      },
      onDrop(x, y) {
        if (!document.elementFromPoint(x, y)?.closest("#board-columns")) return;
        const beforeKey = colBeforeX(x)?.dataset.section ?? null;
        const order = orderedSectionColumns()
          .map((s) => s.key)
          .filter((key) => key !== sec.key);
        const idx = beforeKey ? order.indexOf(beforeKey) : order.length;
        order.splice(idx, 0, sec.key);
        boardColOrder = order;
        localStorage.setItem(BOARD_ORDER_KEY, JSON.stringify(order));
        renderBoardColumns();
      },
      onEnd() {
        col.classList.remove("dragging");
        clearColDropMarker();
      },
    };
  });
  const name = document.createElement("span");
  name.className = "board-col-name";
  name.textContent = sec.name;
  name.title = sec.name;

  const count = document.createElement("span");
  count.className = "board-col-count";
  count.textContent = String(sec.sessions.length);

  header.append(name, count);
  col.appendChild(header);

  const body = document.createElement("div");
  body.className = "board-col-body";
  body.dataset.section = sec.key;
  for (const s of sec.sessions) body.appendChild(renderAgentCard(s));
  col.appendChild(body);
  return col;
}

/** Filter bar: Hide-empty toggle + project filter + name search + primary
 *  "New session". */
function renderBoardFilterBar(): void {
  boardFilterEl.innerHTML = "";

  const pills = document.createElement("div");
  pills.className = "board-pills";

  // Attention summary at the top of the Board, mirroring the title-bar pill
  // (updateTitleBarCounts fills both). Hidden while nothing waits.
  boardAttentionEl = document.createElement("span");
  boardAttentionEl.className = "board-attention hidden";
  boardAttentionEl.setAttribute("role", "button");
  boardAttentionEl.tabIndex = 0;
  boardAttentionEl.setAttribute("aria-live", "polite");
  boardAttentionEl.title = "Jump to the next session that needs you";
  wireAttentionPill(boardAttentionEl);
  pills.appendChild(boardAttentionEl);

  // Toggle: hide section columns with zero visible cards.
  const hideEmpty = document.createElement("button");
  hideEmpty.className = "board-pill hide-empty";
  hideEmpty.textContent = "Hide empty";
  hideEmpty.title = "Hide section columns with no cards";
  hideEmpty.classList.toggle("active", hideEmptyColumns);
  hideEmpty.addEventListener("click", () => {
    hideEmptyColumns = !hideEmptyColumns;
    localStorage.setItem("cc-board-hide-empty", hideEmptyColumns ? "1" : "0");
    renderBoardFilterBar();
    // The rebuild recreated the attention pill blank — refill it now rather
    // than leaving it empty until the next poll snapshot.
    updateTitleBarCounts();
    renderBoardColumns();
  });
  pills.appendChild(hideEmpty);

  const search = noTextAssist(document.createElement("input"));
  search.className = "board-search";
  search.type = "search";
  search.placeholder = "Search sessions…";
  search.value = boardSearch;
  search.addEventListener("input", () => {
    boardSearch = search.value;
    renderBoardColumns();
  });

  const create = document.createElement("button");
  create.className = "board-new primary";
  create.textContent = "＋ New session";
  create.title = "New session";
  create.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));

  boardFilterEl.append(pills, buildProjectFilter(), search, create);
}

/** Multiselect project filter: a button summarising the selection, over a
 *  popover of per-project checkboxes with Select-all / Clear-all helpers.
 *  Defaults to all projects; the selection lives in `boardProjectFilter`. */
function buildProjectFilter(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "board-project-filter";

  const btn = document.createElement("button");
  btn.className = "board-pill board-project-btn";
  btn.title = "Filter by project";

  const panel = document.createElement("div");
  panel.className = "board-project-panel hidden";

  const updateSummary = (): void => {
    const total = allProjectIds().length;
    const sel = selectedProjectIds();
    btn.classList.toggle("active", sel.size !== total);
    let label: string;
    if (sel.size === total) label = "All projects";
    else if (sel.size === 0) label = "No projects";
    else if (sel.size === 1) label = groups.find((g) => sel.has(g.id))?.name ?? "1 project";
    else label = `${sel.size} projects`;
    btn.textContent = `${label} ▾`;
  };

  const commit = (next: Set<string> | null): void => {
    boardProjectFilter = next && next.size === allProjectIds().length ? null : next;
    updateSummary();
    renderBoardColumns();
  };

  const rebuildPanel = (): void => {
    panel.innerHTML = "";
    const tools = document.createElement("div");
    tools.className = "board-project-tools";
    const selectAll = document.createElement("button");
    selectAll.className = "board-project-tool";
    selectAll.textContent = "Select all";
    selectAll.addEventListener("click", (e) => {
      e.stopPropagation();
      commit(null);
      rebuildPanel();
    });
    const clearAll = document.createElement("button");
    clearAll.className = "board-project-tool";
    clearAll.textContent = "Clear all";
    clearAll.addEventListener("click", (e) => {
      e.stopPropagation();
      commit(new Set());
      rebuildPanel();
    });
    tools.append(selectAll, clearAll);
    panel.appendChild(tools);

    const selected = selectedProjectIds();
    for (const g of groups) {
      const row = document.createElement("label");
      row.className = "board-project-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(g.id);
      cb.addEventListener("change", () => {
        const sel = selectedProjectIds();
        if (cb.checked) sel.add(g.id);
        else sel.delete(g.id);
        commit(sel);
      });
      const square = document.createElement("span");
      square.className = `proj-square ${projClass(g.id)}`;
      const name = document.createElement("span");
      name.className = "board-project-name";
      name.textContent = g.name;
      row.append(cb, square, name);
      panel.appendChild(row);
    }
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const close = (): void => {
    panel.classList.add("hidden");
    document.removeEventListener("click", onDocClick, true);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("hidden")) {
      rebuildPanel();
      panel.classList.remove("hidden");
      document.addEventListener("click", onDocClick, true);
    } else {
      close();
    }
  });

  updateSummary();
  wrap.append(btn, panel);
  return wrap;
}

/** Rebuild the columns from the current snapshot + filter + search. */
function renderBoardColumns(): void {
  // Columns are rebuilt wholesale on every snapshot tick (~2s); capture the
  // per-column vertical scroll (keyed by section) + the strip's horizontal
  // scroll so an in-progress session doesn't yank the view back to the top.
  const prevScroll = new Map<string, number>();
  for (const body of boardColumnsEl.querySelectorAll<HTMLElement>(".board-col-body")) {
    if (body.dataset.section) prevScroll.set(body.dataset.section, body.scrollTop);
  }
  const prevScrollLeft = boardColumnsEl.scrollLeft;

  boardCardRefs.clear();
  boardColumnsEl.innerHTML = "";
  for (const sec of orderedSectionColumns()) {
    // "Hide empty" hides columns with no VISIBLE cards, so a section whose
    // sessions are all filtered out drops too.
    if (hideEmptyColumns && sec.sessions.length === 0) continue;
    boardColumnsEl.appendChild(renderBoardColumn(sec));
  }

  for (const body of boardColumnsEl.querySelectorAll<HTMLElement>(".board-col-body")) {
    const top = body.dataset.section ? prevScroll.get(body.dataset.section) : undefined;
    if (top) body.scrollTop = top;
  }
  boardColumnsEl.scrollLeft = prevScrollLeft;
  updateBoardRoving();
}

/** Full board render. The filter bar is rebuilt only when needed (it owns the
 *  live search input); columns rebuild on every snapshot tick. Preserving the
 *  search field's focus/value: the input keeps its own value, and a snapshot
 *  re-render only touches columns, never the filter bar. */
function renderBoard(): void {
  if (!boardFilterEl.childElementCount) renderBoardFilterBar();
  renderBoardColumns();
}

function applySnapshot(snap: Snapshot): void {
  applyPendingOverlays(snap);
  groups = snap.groups;
  viewMode = snap.view_mode;
  sections = snap.sections;
  sectionNames = snap.section_names;
  commanderEnabled = snap.commander.enabled;
  renderSidebar();
  renderBoard();
  // After renderBoard: the board's attention pill is created with the filter
  // bar, and updateTitleBarCounts fills both pills.
  updateTitleBarCounts();
  renderOnboarding();
  updateTabGlyphs();
  renderCommander(snap.commander);
}

// ---------------------------------------------------------------- palette

registerPaletteProvider(() =>
  groups.flatMap((g) =>
    g.sessions.map((s) => {
      const key = sessionStateKey(s);
      return {
        kind: "session" as const,
        label: s.title,
        hint: `${g.name} · ${s.branch}`,
        projClass: projClass(s.project_id),
        project: g.name,
        state: sessionStateWord(s, key),
        stateTone: stateChipInfo(key).tone,
        action: () => void openTerminal(s),
      };
    }),
  ),
);

registerPaletteProvider(() => [
  { label: "Cycle view mode", hint: "command", icon: "⇄", iconTone: "info", shortcut: kb("toggle_view_mode"), action: cycleViewMode },
  {
    label: "Add project…",
    hint: "command",
    icon: "＋",
    iconTone: "success",
    shortcut: kb("new_project"),
    action: () => {
      topInput = "add";
      renderSidebar();
    },
  },
  {
    label: "Scan directory for repos…",
    hint: "command",
    icon: "⌕",
    iconTone: "success",
    shortcut: kb("scan_directory"),
    action: () => {
      topInput = "scan";
      renderSidebar();
    },
  },
  {
    label: "Delete merged-PR sessions…",
    hint: "command",
    icon: "⌦",
    iconTone: "danger",
    shortcut: kb("delete_merged_pr_sessions"),
    action: () => void deleteMergedSessions(),
  },
  {
    label: "Refresh PR status",
    hint: "command",
    icon: "↻",
    iconTone: "info",
    action: () => {
      toast("Refreshing PR status…");
      void invoke("refresh_pr_status").catch((e) => toast(`${e}`, "error"));
    },
  },
  {
    label: "Attach commander session",
    hint: "command",
    icon: "◈",
    iconTone: "info",
    shortcut: kb("open_commander"),
    action: () => commanderChip.click(),
  },
  { label: "Open file explorer", hint: "command", icon: "▤", iconTone: "info", shortcut: "⌘E", action: openFileExplorer },
  // PROTOTYPE: delete with markdownViewerPrototype.ts
  { label: "Markdown viewer (prototype)", hint: "command", icon: "◫", iconTone: "info", shortcut: "⌘M", action: openMarkdownViewerForActiveSession },
  { label: "Settings", hint: "command", icon: "⚙", iconTone: "dim", shortcut: kb("show_settings"), action: () => void openSettings() },
  { label: "Help", hint: "command", icon: "?", iconTone: "dim", shortcut: kb("show_help"), action: toggleHelp },
]);

// Theme commands: the two slot pickers (open a modal listing that appearance's
// themes, with live preview), the mode toggles, and custom-theme management.
registerPaletteProvider(() => [
  { label: "Theme: Set dark theme…", hint: "command", icon: "◐", iconTone: "dim", action: () => openThemeModal("dark") },
  { label: "Theme: Set light theme…", hint: "command", icon: "◐", iconTone: "dim", action: () => openThemeModal("light") },
  { label: "Theme: Dark mode", hint: "force dark", icon: "◐", iconTone: "dim", action: () => setMode("dark") },
  { label: "Theme: Light mode", hint: "force light", icon: "◐", iconTone: "dim", action: () => setMode("light") },
  { label: "Theme: Follow system", hint: "follow OS appearance", icon: "◐", iconTone: "dim", action: () => setMode("system") },
  { label: "Theme: Reload custom themes", hint: "command", icon: "◐", iconTone: "dim", action: () => void loadCustomThemes(true) },
  {
    label: "Theme: Export current theme as template…",
    hint: "command",
    icon: "◐",
    iconTone: "dim",
    action: () => void exportThemeTemplate(),
  },
  {
    label: "Theme: Open themes folder…",
    hint: "command",
    icon: "◐",
    iconTone: "dim",
    action: () => void invoke("open_themes_dir").catch((e) => toast(`${e}`, "error")),
  },
]);

// ------------------------------------------------------------- keybindings

/**
 * GUI handlers for claude-commander's bindable actions, dispatched with the
 * key table from the shared config (`[keybindings]` in config.toml). Actions
 * with no GUI equivalent (checkout_branch, new_stacked_session, scrolling,
 * quit, …) are simply not listed here.
 */
const KEY_ACTIONS: Record<string, { label: string; run: () => void }> = {
  navigate_up: { label: "Move cursor up", run: () => moveSelection(-1) },
  navigate_down: { label: "Move cursor down", run: () => moveSelection(1) },
  next_group: { label: "Jump to next group", run: () => moveGroup(1) },
  previous_group: { label: "Jump to previous group", run: () => moveGroup(-1) },
  navigate_first: {
    label: "Jump to first session",
    run: () => {
      const flat = visibleGroups.flat();
      if (flat.length) selectRow(flat[0]);
    },
  },
  navigate_last: {
    label: "Jump to last session",
    run: () => {
      const flat = visibleGroups.flat();
      if (flat.length) selectRow(flat[flat.length - 1]);
    },
  },
  select: {
    label: "Attach cursor session",
    run: () => {
      const s = targetSession();
      if (s) void openTerminal(s);
    },
  },
  select_shell: {
    label: "Open shell for cursor session",
    run: () => {
      const s = targetSession();
      if (s) void openShell(s);
    },
  },
  new_session: {
    label: "New session in cursor project",
    run: () => {
      const s = targetSession();
      const g = s ? groupOf(s.id) : groups[0];
      if (!g) return;
      // In the Status grouping the create-input lives under the cursor
      // session's project sub-header within its tier, so scope the key to it.
      if (statusGrouping && s) {
        const tier = sessionTier(s);
        const label = STATUS_TIERS.find((t) => t.tier === tier)!.label;
        newSessionProject = sectionCreateKey(label, g.id);
        collapsed.delete(`tier:${tier}`);
        renderSidebar();
        return;
      }
      // In a section view the create-input lives under the cursor session's
      // project sub-header within its section bucket, so scope the key to it.
      if (SECTION_VIEW() && s && sections) {
        const bucket = sections.find((b) => b.session_ids.includes(s.id));
        if (bucket) {
          newSessionProject = sectionCreateKey(bucket.name, g.id);
          collapsed.delete(`sect:${bucket.name}`);
          renderSidebar();
          return;
        }
      }
      newSessionProject = g.id;
      collapsed.delete(`proj:${g.id}`);
      renderSidebar();
    },
  },
  new_project: {
    label: "Add project",
    run: () => {
      topInput = "add";
      renderSidebar();
    },
  },
  scan_directory: {
    label: "Scan directory for repos",
    run: () => {
      topInput = "scan";
      renderSidebar();
    },
  },
  rename_session: {
    label: "Rename cursor session",
    run: () => {
      const s = targetSession();
      if (!s) return;
      renamingId = s.id;
      renderSidebar();
    },
  },
  delete_session: {
    label: "Delete cursor session",
    run: () => {
      const s = targetSession();
      if (!s) return;
      void confirmDialog(
        `Delete session "${s.title}"?\nThis removes the worktree and branch.`,
        "Delete",
      ).then((ok) => {
        if (ok) deleteSession(s);
      });
    },
  },
  delete_merged_pr_sessions: {
    label: "Delete merged-PR sessions",
    run: () => void deleteMergedSessions(),
  },
  restart_session: {
    label: "Restart cursor session (if stopped)",
    run: () => {
      const s = targetSession();
      if (s?.status === "stopped") void lifecycle("restart_session", s.id);
    },
  },
  remove_project: {
    label: "Remove cursor project",
    run: () => {
      const s = targetSession();
      const g = s ? groupOf(s.id) : undefined;
      if (!g) return;
      void confirmDialog(
        `Remove project "${g.name}" and all ${g.sessions.length} session(s)?\nWorktrees and tmux sessions will be removed.`,
        "Remove",
      ).then((ok) => {
        if (ok) void lifecycle("remove_project", g.id);
      });
    },
  },
  open_in_editor: {
    label: "Open cursor session in editor",
    run: () => {
      const s = targetSession();
      if (s) void lifecycle("open_in_editor", s.id);
    },
  },
  open_pull_request: {
    label: "Open cursor session's PR",
    run: () => {
      const s = targetSession();
      if (s?.pr_url) void invoke("open_external", { url: s.pr_url });
    },
  },
  open_commander: { label: "Attach commander session", run: () => commanderChip.click() },
  open_review_diff: {
    label: "Review diff of cursor session",
    run: () => {
      const s = targetSession();
      if (s) void openReview(s.id, s.title);
    },
  },
  cascade_merge_main: {
    label: "Cascade-merge main into cursor stack",
    run: () => {
      const s = targetSession();
      if (s) void invokeToast("cascade_merge", { id: s.id });
    },
  },
  cascade_resume: { label: "Resume paused cascade", run: () => void invokeToast("cascade_resume", {}) },
  cascade_abandon: { label: "Abandon paused cascade", run: () => void invokeToast("cascade_abandon", {}) },
  push_stack: {
    label: "Push cursor stack to origin",
    run: () => {
      const s = targetSession();
      if (s) void invokeToast("push_stack", { id: s.id });
    },
  },
  generate_summary: {
    label: "Generate AI summary for cursor session",
    run: () => {
      const s = targetSession();
      if (!s) return;
      if (detailId !== s.id) toggleDetail(s);
      void generateSummary();
    },
  },
  toggle_details: {
    label: "Toggle details for cursor session",
    run: () => {
      const s = targetSession();
      if (s) toggleDetail(s);
    },
  },
  toggle_section: {
    label: "Collapse/expand cursor group",
    run: () => {
      const s = targetSession();
      if (statusGrouping) {
        // Cursor session's tier, else the first tier that actually rendered.
        const tier = s
          ? sessionTier(s)
          : STATUS_TIERS.find((t) => groups.some((g) => g.sessions.some((x) => sessionTier(x) === t.tier)))?.tier;
        if (tier) toggleCollapsed(`tier:${tier}`);
      } else if (SECTION_VIEW() && sections) {
        const b = s ? sections.find((b) => b.session_ids.includes(s.id)) : sections[0];
        if (b) toggleCollapsed(`sect:${b.name}`);
      } else {
        const g = s ? groupOf(s.id) : groups[0];
        if (g) toggleCollapsed(`proj:${g.id}`);
      }
    },
  },
  toggle_view_mode: { label: "Cycle view mode", run: cycleViewMode },
  shrink_left_pane: { label: "Shrink sidebar", run: () => adjustPanelWidth("cc-sidebar-width", -24) },
  grow_left_pane: { label: "Grow sidebar", run: () => adjustPanelWidth("cc-sidebar-width", 24) },
  // toggle_pane (bare Tab in the TUI) is intentionally not mapped: the GUI has
  // no two-pane focus model, and stealing Tab would break normal focus
  // traversal across the chrome. Clicking a row already focuses its terminal.
  show_help: { label: "Toggle help", run: toggleHelp },
  show_settings: { label: "Open settings", run: () => void openSettings() },
};

// A single-char key's glyph already implies Shift (e.g. "?" is Shift+/), and the
// GUI dispatch ignores the Shift bit for single chars — so the commander default
// binding both "Shift-?" and "?" lists the same physical key twice. Drop the
// redundant "Shift-" prefix and de-dupe so each key shows once.
/** Formatted glyphs for an action's primary config binding, for menu/palette
 *  shortcut hints. Undefined when the action is unbound or unparseable. */
function kb(action: string): string | undefined {
  const first = (loadedBindings[action] ?? [])[0];
  return (first && formatBinding(first)) || undefined;
}

function helpKeyLabel(keys: string[]): string {
  const seen = new Set(keys.map((k) => k.replace(/^Shift-(?=\S$)/, "")));
  return [...seen].join(", ");
}

function applyHelpKeybindings(): void {
  setHelpKeybindings(
    Object.entries(KEY_ACTIONS)
      .map(([action, a]) => [helpKeyLabel(loadedBindings[action] ?? []), a.label] as [string, string])
      .filter(([keys]) => keys.length > 0),
  );
}

void initKeybindings(
  Object.fromEntries(Object.entries(KEY_ACTIONS).map(([action, a]) => [action, a.run])),
).then((loaded) => {
  if (!loaded) {
    // Keep "?" working even when the keybinding table couldn't be fetched.
    document.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      const typing =
        t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.closest(".xterm");
      if (e.key === "?" && !typing && !keyOverlayOpen()) toggleHelp();
    });
    return;
  }
  applyHelpKeybindings();
});

// Backend hot-reloaded config.toml (edited by another instance or by hand):
// refresh the keybinding table and the help overlay's listing.
void listen("config-updated", async () => {
  if (await reloadKeybindings()) applyHelpKeybindings();
});

// Esc dismisses the detail panel when it's open, else clears the keyboard
// cursor (overlays handle their own Esc).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailId && !keyOverlayOpen() && !(e.target as HTMLElement).closest(".xterm")) {
    closeDetail();
    return;
  }
  if (e.key === "Escape" && selectedId && !keyOverlayOpen() && !(e.target as HTMLElement).closest(".xterm")) {
    selectRow(null);
  }
});

void listen<Snapshot>("sessions-updated", (event) => applySnapshot(event.payload));

invoke<Snapshot>("get_groups")
  .then((snap) => {
    // The push loop may have rendered already; don't regress its richer data.
    if (!groups.length) applySnapshot(snap);
  })
  .catch((e) => {
    sessionsEl.innerHTML = `<div class="error">Error: ${e}</div>`;
  });
