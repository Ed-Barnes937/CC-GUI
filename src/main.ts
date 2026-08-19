import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { openReview, closeReview } from "./review";
import { openExplorer, closeExplorer, isExplorerOpen } from "./fileExplorer";
import { openMarkdownViewer, closeMarkdownViewer, isMarkdownViewerOpen } from "./markdownViewer";
import { toast, confirmDialog, promptDialog } from "./toast";
import { makeResizable, adjustPanelWidth } from "./resize";
import { showContextMenu, MenuItem } from "./menu";
import { kb } from "./keys";
import { registerPaletteProvider, togglePalette } from "./palette";
import { toggleHelp, setHelpKeybindings } from "./help";
import {
  initKeybindings,
  reloadKeybindings,
  loadedBindings,
  overlayOpen as keyOverlayOpen,
  rebindActions,
} from "./keys";
import { openSettings } from "./settings";
import { commentsChip, pullBlockedChip, stackChip, stateChipInfo, STATUS_TIERS, type StatusTier } from "./status";
import { noTextAssist } from "./dom";
import { draggable } from "./drag";
import {
  sessionStateKey,
  sessionStateWord,
  sessionStatusChip,
  sessionTier,
} from "./session/glyph";
import { createSessionInProject, projectPickerItems, startSession } from "./session/create";
import {
  activeTerm,
  focusedSlot,
  panes,
  refitActive,
  splitActive,
  terminals,
} from "./terminal/state";
import {
  dockActiveTerminal,
  exitSplit,
  setDockDetached,
  undockTerminal,
  updateDockHeader,
} from "./terminal/surface";
import { activateTabByIndex, cycleTab } from "./terminal/tabs";
import { attachTerminal, openProjectShell, openShell, openTerminal } from "./terminal/attach";
import "./terminal/restart";
import { diffstatBar, parseDiffStat } from "./session/diffstat";
import { closeDetail, detailOpenFor, generateSummary, toggleDetail } from "./session/detail";
import {
  moveGroup,
  moveSelection,
  onSelectionChange,
  pushVisibleRows,
  resetVisibleRows,
  selectRow,
  selectedSession,
  targetSession,
  visibleRows,
} from "./session/selection";
import {
  actionButton,
  buildActions,
  deleteSession,
  prBadge,
  branchMatchesTitle,
  projClass,
  renamingId,
  rowRefs,
  setRenamingId,
  sessionMenuItems,
  updateRow,
  type RowRefs,
} from "./session/row";
import {
  initTheme,
  setMode,
  currentTheme,
  followSystem,
  resolveTheme,
  applyTheme,
  registerCustomThemes,
  validateTheme,
  type Theme,
} from "./theme";
import { openThemeModal } from "./themeModal";
import { createHarnessPicker } from "./harnessPicker";
import { featurePalette, featureActions, onFeatureChange } from "./features";
import "./featureList";
import type {
  SessionRow,
  ProjectGroup,
  SectionBucket,
  Snapshot,
  SessionDetail,
} from "./app/types";
import {
  sessionsEl,
  detailEl,
  onboardingEl,
  onboardingAddProjectBtn,
  onboardingCommanderBtn,
  appEl,
  tbCount,
  tbAttention,
  tbConsole,
  tbBoard,
  commanderChip,
  boardEl,
  boardFilterEl,
  boardColumnsEl,
  boardDockEl,
  boardDockBackdropEl,
} from "./app/elements";
import { registerView } from "./app/render";
import {
  applySnapshot,
  commanderEnabled,
  commanderStatus,
  findSession,
  groupOf,
  groups,
  hasSnapshot,
  layout,
  maskTitle,
  sectionNames,
  sectionView,
  sections,
  setLayoutPref,
  setStatusGrouping,
  setViewModePref,
  statusGrouping,
  unmaskTitle,
  viewMode,
} from "./app/store";
import { actionErrorToast, invokeToast, lifecycle, lifecycleArgs, refreshNow } from "./app/actions";

// Apply the GUI theme (CSS custom properties) before any dynamic content renders,
// then follow the OS appearance via the native Tauri theme event when in System mode.
initTheme();
void getCurrentWindow().onThemeChanged(() => followSystem());

// Dropping OS files onto the window inserts them as `@<path>` references into the
// active session's prompt (mirrors the file explorer's reference insertion).
// Requires `dragDropEnabled: true` in tauri.conf.json.
void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop") return;
  const target = activeTerm();
  if (!target) {
    toast("No active session to drop files into", "error");
    return;
  }
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
  } else if (e.key === "Enter" && selectedSession()) {
    e.preventDefault();
    const s = findSession(selectedSession()!);
    if (s) void openTerminal(s);
  }
});

// ---------------------------------------------------------------- terminals

/** Move the sidebar cursor by `delta` and attach the newly selected session. */
function cycleSession(delta: number): void {
  // Seed the cursor from the active terminal so the first press moves relative
  // to what's on screen, not from the top of the list.
  if (!selectedSession()) {
    const cur = targetSession();
    if (cur) selectRow(cur.id);
  }
  moveSelection(delta);
  const cursor = selectedSession();
  const s = cursor ? findSession(cursor) : undefined;
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
  const name = activeTerm();
  const s = name
    ? groups().flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name)
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

// Cmd+M toggles the markdown viewer over the active session's repo, same
// capture-phase accel pattern as Cmd+E below.
function openMarkdownViewerForActiveSession(): void {
  const name = activeTerm();
  const s = name
    ? groups().flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name)
    : undefined;
  if (!name || !s) {
    toast("No active session", "error");
    return;
  }
  void openMarkdownViewer({
    sessionId: s.id,
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
      const name = activeTerm();
      if (name) terminals.get(name)?.term.focus();
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

// ----------------------------------------------------------------- sidebar

// Key of the project header with an open create-input. In project view this is
// the bare project id; in section view it's scoped to the section (see
// `sectionCreateKey`) so the same project across sections opens independently.
let newSessionProject: string | null = null;
let topInput: "add" | "scan" | null = null; // sidebar-top path input mode
// Project the session list is filtered to (toggled from the projects rail), or
// null for "all projects". Composes with whichever grouping is active.
let projectFilter: string | null = null;

// Board layout: which cards are visible (filter pills) + a name search. Mirrors
// projectFilter's "local UI state, re-render on change" shape.
let boardSearch = "";
// Project multiselect filter: the set of selected project ids, or null for "all
// projects" (the default). Cards whose project isn't selected are hidden across
// every section column.
let boardProjectFilter: Set<string> | null = null;
// Hide section columns with zero visible cards (persisted).
let hideEmptyColumns = localStorage.getItem("cc-board-hide-empty") === "1";

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

function renderRenameInput(s: SessionRow): HTMLInputElement {
  const input = noTextAssist(document.createElement("input"));
  input.className = "rename-input";
  input.value = s.title;
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      setRenamingId(null);
      renderSidebar();
    }
    if (e.key === "Enter" && input.value.trim()) {
      const title = input.value.trim();
      setRenamingId(null);
      // Optimistic: show the new title immediately; the mask clears once a
      // snapshot carries the new title (see applyPendingOverlays).
      maskTitle(s.id, title);
      s.title = title;
      invoke("rename_session", { id: s.id, title })
        .then(() => refreshNow())
        .catch((err) => {
          unmaskTitle(s.id); // failed: un-mask so the old title returns
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

  if (renamingId() === s.id) {
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
function applyViewMode(mode: string): void {
  if ((mode === "sections" || mode === "section_stacks") && sectionNames().length === 0) {
    mode = "project";
  }
  setViewModePref(mode);
  renderSidebar();
}

function cycleViewMode(): void {
  // Backend grouping modes, then the GUI-only Status stop. Section modes drop
  // out of the cycle when no sections are configured.
  const modes = sectionNames().length ? ["project", "sections", "section_stacks"] : ["project"];
  if (statusGrouping()) {
    // Status (GUI-only) is the cycle's last stop; leaving it restarts at the top.
    setStatusGrouping(false);
    applyViewMode(modes[0]);
    return;
  }
  const idx = modes.indexOf(viewMode());
  if (idx === modes.length - 1) {
    setStatusGrouping(true);
    return;
  }
  applyViewMode(modes[idx + 1]);
}

/** Switch grouping to an explicit mode (the GROUP BY segmented control). */
function setViewMode(mode: string): void {
  setStatusGrouping(false); // leaving the GUI-only Status override, if it's on
  if (mode === viewMode()) return;
  applyViewMode(mode);
}

/** GROUP BY segmented control: [Sections | Projects | Status]. Sections and
 *  Projects are bound to viewMode (Projects→"project", Sections→"sections";
 *  "section_stacks" still counts as the Sections side and stays reachable via
 *  the palette's cycleViewMode). Status is the GUI-only tier grouping and
 *  overrides whichever viewMode sits underneath. */
function renderGroupByBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "group-by-bar";
  const label = document.createElement("span");
  label.className = "group-by-label";
  label.textContent = "GROUP BY";

  const seg = document.createElement("div");
  seg.className = "segmented";
  const sectionsActive = !statusGrouping() && (viewMode() === "sections" || viewMode() === "section_stacks");

  const sectionsBtn = document.createElement("button");
  sectionsBtn.className = "segment";
  sectionsBtn.textContent = "Sections";
  sectionsBtn.classList.toggle("active", sectionsActive);
  sectionsBtn.addEventListener("click", () => setViewMode("sections"));

  const projectsBtn = document.createElement("button");
  projectsBtn.className = "segment";
  projectsBtn.textContent = "Projects";
  projectsBtn.classList.toggle("active", !statusGrouping() && !sectionsActive);
  projectsBtn.addEventListener("click", () => setViewMode("project"));

  const statusBtn = document.createElement("button");
  statusBtn.className = "segment";
  statusBtn.textContent = "Status";
  statusBtn.classList.toggle("active", statusGrouping());
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
  const projById = new Map(groups().map((g) => [g.id, g]));
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
      pushVisibleRows(rows.map((s) => s.id));
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
    groups()
      .map((g) => `${g.id}@${g.pull_blocked}:${g.sessions.map((s) => s.id).join(",")}`)
      .join("|") +
    `#${newSessionProject}#${renamingId()}#${topInput}#${viewMode()}#${projectFilter}` +
    `#${sections()?.map((b) => `${b.name}=${b.session_ids.join(",")}`).join("|") ?? ""}` +
    // Status grouping: tier membership must force a rebuild (a status flip has
    // to move the row between tiers, which updateRow alone can't do).
    `#${statusGrouping() ? "status:" + groups().flatMap((g) => g.sessions.map((s) => `${s.id}=${sessionTier(s)}`)).join(",") : ""}` +
    `#${[...collapsed].sort().join(",")}`;

  if (signature === sidebarSignature) {
    for (const group of groups()) {
      for (const s of group.sessions) {
        const refs = rowRefs.get(s.id);
        if (refs) updateRow(refs, s);
      }
    }
    return;
  }

  sidebarSignature = signature;
  rowRefs.clear();
  resetVisibleRows();
  sessionsEl.innerHTML = "";
  if (topInput) {
    sessionsEl.appendChild(renderTopInput(topInput));
  }

  // Grouping control, shown in every view.
  sessionsEl.appendChild(renderGroupByBar());

  // When a project filter is active, show a banner with a clear affordance.
  const filterGroup = projectFilter ? groups().find((g) => g.id === projectFilter) : undefined;
  if (filterGroup) {
    sessionsEl.appendChild(renderFilterBanner(filterGroup));
  }

  // The GUI-only Status grouping overrides whichever view mode is active.
  if (statusGrouping()) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderStatusTiers();
    return;
  }

  const buckets = sections();
  if (sectionView() && buckets) {
    sessionsEl.appendChild(renderNewSessionButton());
    renderSections(buckets);
    return;
  }

  for (const group of groups()) {
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
    pushVisibleRows(group.sessions.map((s) => s.id));
  }
}

// The sidebar redraws on request rather than by direct call, so a terminal
// exit or a board action can ask for it without importing it.
registerView("sidebar", renderSidebar);

// The sidebar draws the keyboard cursor on its rows, and mirrors it to the
// listbox's aria-activedescendant so assistive tech follows the same row.
onSelectionChange(() => {
  const id = selectedSession();
  for (const [rowId, refs] of rowRefs) {
    const sel = rowId === id;
    refs.row.classList.toggle("selected", sel);
    refs.row.setAttribute("aria-selected", sel ? "true" : "false");
  }
  sessionsEl.setAttribute("aria-activedescendant", id ? `row-${id}` : "");
  if (id) rowRefs.get(id)?.row.scrollIntoView({ block: "nearest" });
});

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
  for (const g of groups()) {
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

  const projById = new Map(groups().map((g) => [g.id, g]));
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
      pushVisibleRows(rows.map((s) => s.id));
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


/** First-run hero state: no projects and nothing attached. */
function onboardingActive(): boolean {
  return groups().length === 0 && terminals.size === 0;
}

function renderOnboarding(): void {
  const show = onboardingActive();
  const wasShown = !onboardingEl.classList.contains("hidden");
  onboardingEl.classList.toggle("hidden", !show);
  // Board layout hides #terminal-pane, which hosts the hero — so a persisted
  // Board layout (or deleting the last project while on the Board) would show
  // a blank surface instead of first-run guidance. Yield to Console while the
  // hero is up; the Board segment is guarded below for the same reason.
  if (show && layout() === "board") setLayout("console");
  // Card 3 is only a live control when the commander is actually configured —
  // otherwise it reads inert, like card 2's "After a project" placeholder,
  // rather than firing prepare_commander into a raw error toast.
  onboardingCommanderBtn.disabled = !commanderEnabled();
  onboardingCommanderBtn.classList.toggle("outline", commanderEnabled());
  onboardingCommanderBtn.classList.toggle("muted", !commanderEnabled());
  // On first show, focus the primary path so Enter fires "Choose folder…"
  // (the ⏎-hinted CTA) rather than nothing — card 3's commander button is
  // disabled here, so it must never be the implicit Enter target.
  if (show && !wasShown) onboardingAddProjectBtn.focus();
}

registerView("onboarding", renderOnboarding);

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

// The board's mirror of the attention pill; created with the filter bar.
let boardAttentionEl: HTMLSpanElement | null = null;

/** Sessions waiting on the user: the agent asked for input, or finished while
 *  away (unread) — the at-a-glance attention queue, in sidebar snapshot order.
 *  In lockstep with the status-chip vocabulary via sessionStateKey. */
function attentionSessions(): SessionRow[] {
  return groups().flatMap((g) => g.sessions).filter((s) => {
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
  const cur = selectedSession() ? queue.findIndex((s) => s.id === selectedSession()) : -1;
  const next = queue[(cur + 1) % queue.length];
  setLayout("console");
  selectRow(next.id);
  void openTerminal(next);
}

function updateTitleBarCounts(): void {
  const total = groups().reduce((n, g) => n + g.sessions.length, 0);
  const live = groups().flatMap((g) => g.sessions).filter((s) => s.status === "running").length;
  tbCount.textContent = `${total} sessions · ${live} live`;
  const waiting = attentionCount();
  tbAttention.textContent = `${waiting} waiting on you`;
  tbAttention.classList.toggle("hidden", waiting === 0);
  if (boardAttentionEl) {
    boardAttentionEl.textContent = `${waiting} waiting on you`;
    boardAttentionEl.classList.toggle("hidden", waiting === 0);
  }
}

registerView("titlebar", updateTitleBarCounts);

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
  if (next === layout()) return;
  // Split lives only in console. Collapse it (keeping the focused pane) while
  // the DOM is still in console layout, before switching surfaces.
  const slot = focusedSlot();
  if (splitActive()) exitSplit(slot ? panes.get(slot)! : activeTerm());
  setLayoutPref(next);
  closeReview();
  appEl.classList.toggle("board-mode", next === "board");
  boardEl.classList.toggle("hidden", next !== "board");
  tbConsole.classList.toggle("active", next === "console");
  tbBoard.classList.toggle("active", next === "board");
  // Re-parent the active terminal into/out of the dock now that the target
  // surface is visible, then fit it (dock/undock fit internally).
  if (next === "board") {
    setDockDetached(false); // a fresh board entry re-docks the active terminal
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
appEl.classList.toggle("board-mode", layout() === "board");
boardEl.classList.toggle("hidden", layout() !== "board");
tbConsole.classList.toggle("active", layout() === "console");
tbBoard.classList.toggle("active", layout() === "board");
// Dock the active terminal (if any) when booting straight into board mode.
if (layout() === "board") dockActiveTerminal();

// Dock "×" closes the preview: undock the terminal back to #terminals and
// collapse the whole dock panel so the columns fill the board. It does NOT kill
// the PTY — the session stays attached and the terminal reappears in Console
// (or on the next card ▸, which reopens the dock). Also drops out of the
// fullscreen overlay if it was open (nothing left to show fullscreen).
document.querySelector<HTMLButtonElement>("#board-dock-close")!.addEventListener("click", () => {
  setDockFullscreen(false);
  undockTerminal();
  setDockDetached(true);
  updateDockHeader();
});
// Dock "⤢": float the docked terminal into a centred ~85% overlay over a dimmed
// backdrop — obviously a dismissable dialog, not a panel that ate the window.
// Toggling clears any drag-set inline height so the overlay's CSS size wins, and
// re-fits the xterm into the new surface.
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
  if (layout() === "board") dockActiveTerminal();
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
    if (layout() === "board") dockActiveTerminal();
  },
});

// ------------------------------------------------------------ commander chip


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

registerView("commander", () => renderCommander(commanderStatus()));

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
  return groups().map((g) => g.id);
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
  for (const name of sectionNames()) {
    const col: BoardSection = { key: name, name, sessions: [] };
    byName.set(name, col);
    cols.push(col);
  }
  for (const g of groups()) {
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
  card.classList.toggle("selected", selectedSession() === s.id);
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
    setDockDetached(false); // an explicit attach re-docks even after a "×" detach
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
    (selectedSession() ? boardCardRefs.get(selectedSession()!) : undefined) ??
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
    else if (sel.size === 1) label = groups().find((g) => sel.has(g.id))?.name ?? "1 project";
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
    for (const g of groups()) {
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

registerView("board", renderBoard);

// Board cards draw the same cursor the sidebar rows do.
onSelectionChange(() => {
  const id = selectedSession();
  for (const [cardId, card] of boardCardRefs) card.classList.toggle("selected", cardId === id);
});

// ---------------------------------------------------------------- palette

registerPaletteProvider(() =>
  groups().flatMap((g) =>
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
  { label: "Markdown viewer", hint: "command", icon: "◫", iconTone: "info", shortcut: "⌘M", action: openMarkdownViewerForActiveSession },
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

// Commands contributed by enabled optional features (Settings → Features). Read
// on each palette open, so a toggle takes effect without a restart.
registerPaletteProvider(featurePalette);

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
      const flat = visibleRows().flat();
      if (flat.length) selectRow(flat[0]);
    },
  },
  navigate_last: {
    label: "Jump to last session",
    run: () => {
      const flat = visibleRows().flat();
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
      const g = s ? groupOf(s.id) : groups()[0];
      if (!g) return;
      // In the Status grouping the create-input lives under the cursor
      // session's project sub-header within its tier, so scope the key to it.
      if (statusGrouping() && s) {
        const tier = sessionTier(s);
        const label = STATUS_TIERS.find((t) => t.tier === tier)!.label;
        newSessionProject = sectionCreateKey(label, g.id);
        collapsed.delete(`tier:${tier}`);
        renderSidebar();
        return;
      }
      // In a section view the create-input lives under the cursor session's
      // project sub-header within its section bucket, so scope the key to it.
      const buckets = sections();
      if (sectionView() && s && buckets) {
        const bucket = buckets.find((b) => b.session_ids.includes(s.id));
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
      setRenamingId(s.id);
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
      if (detailOpenFor() !== s.id) toggleDetail(s);
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
      if (statusGrouping()) {
        // Cursor session's tier, else the first tier that actually rendered.
        const tier = s
          ? sessionTier(s)
          : STATUS_TIERS.find((t) => groups().some((g) => g.sessions.some((x) => sessionTier(x) === t.tier)))?.tier;
        if (tier) toggleCollapsed(`tier:${tier}`);
      } else if (sectionView() && sections()) {
        const buckets = sections()!;
        const b = s ? buckets.find((b) => b.session_ids.includes(s.id)) : buckets[0];
        if (b) toggleCollapsed(`sect:${b.name}`);
      } else {
        const g = s ? groupOf(s.id) : groups()[0];
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
function helpKeyLabel(keys: string[]): string {
  const seen = new Set(keys.map((k) => k.replace(/^Shift-(?=\S$)/, "")));
  return [...seen].join(", ");
}

/** KEY_ACTIONS plus the actions contributed by enabled optional features. A
 *  feature that's switched off contributes nothing, so its keys stay unbound
 *  and the help overlay doesn't list them. */
function allKeyActions(): Record<string, { label: string; run: () => void }> {
  return { ...KEY_ACTIONS, ...featureActions() };
}

function applyHelpKeybindings(): void {
  setHelpKeybindings(
    Object.entries(allKeyActions())
      .map(([action, a]) => [helpKeyLabel(loadedBindings[action] ?? []), a.label] as [string, string])
      .filter(([keys]) => keys.length > 0),
  );
}

const dispatchActions = (): Record<string, () => void> =>
  Object.fromEntries(Object.entries(allKeyActions()).map(([action, a]) => [action, a.run]));

void initKeybindings(dispatchActions()).then((loaded) => {
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

// Toggling an optional feature adds or removes its actions: rebuild the
// dispatch table from the same bindings and refresh the help overlay to match.
onFeatureChange(() => {
  rebindActions(dispatchActions());
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
  if (e.key === "Escape" && detailOpenFor() && !keyOverlayOpen() && !(e.target as HTMLElement).closest(".xterm")) {
    closeDetail();
    return;
  }
  if (e.key === "Escape" && selectedSession() && !keyOverlayOpen() && !(e.target as HTMLElement).closest(".xterm")) {
    selectRow(null);
  }
});

void listen<Snapshot>("sessions-updated", (event) => applySnapshot(event.payload));

invoke<Snapshot>("get_groups")
  .then((snap) => {
    // The push loop may have rendered already; don't regress its richer data.
    if (!hasSnapshot()) applySnapshot(snap);
  })
  .catch((e) => {
    sessionsEl.innerHTML = `<div class="error">Error: ${e}</div>`;
  });
