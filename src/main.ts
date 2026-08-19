import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { openReview } from "./review";
import { openExplorer, closeExplorer, isExplorerOpen } from "./fileExplorer";
import { openMarkdownViewer, closeMarkdownViewer, isMarkdownViewerOpen } from "./markdownViewer";
import { toast, confirmDialog, promptDialog } from "./toast";
import { makeResizable, adjustPanelWidth } from "./resize";
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
import { stateChipInfo, STATUS_TIERS } from "./status";
import {
  sessionStateKey,
  sessionStateWord,
  sessionTier,
} from "./session/glyph";
import {
  activeTerm,
  refitActive,
  terminals,
} from "./terminal/state";
import { activateTabByIndex, cycleTab } from "./terminal/tabs";
import { attachTerminal, openShell, openTerminal } from "./terminal/attach";
import "./terminal/restart";
import { closeDetail, detailOpenFor, generateSummary, toggleDetail } from "./session/detail";
import { renderSidebar } from "./sidebar/index";
import "./board/index";
import { attentionCount, boardAttentionPill } from "./chrome/attention";
import { setLayout } from "./chrome/layout";
import {
  cycleViewMode,
  expandGroup,
  sectionCreateKey,
  setNewSessionProject,
  setTopInput,
  toggleCollapsed,
} from "./sidebar/state";
import { deleteMergedSessions } from "./sidebar/menus";
import {
  moveGroup,
  moveSelection,
  selectRow,
  selectedSession,
  targetSession,
  visibleRows,
} from "./session/selection";
import {
  deleteSession,
  projClass,
  setRenamingId,
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
import { featurePalette, featureActions, onFeatureChange } from "./features";
import "./featureList";
import type {
  Snapshot,
} from "./app/types";
import {
  sessionsEl,
  detailEl,
  onboardingEl,
  onboardingAddProjectBtn,
  onboardingCommanderBtn,
  tbCount,
  tbAttention,
  tbConsole,
  tbBoard,
  commanderChip,
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
  sectionView,
  sections,
  statusGrouping,
} from "./app/store";
import { actionErrorToast, invokeToast, lifecycle, refreshNow } from "./app/actions";

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
      setTopInput("add");
      renderSidebar();
    }
  });
});

onboardingCommanderBtn.addEventListener("click", () => commanderChip.click());

// ----------------------------------------------------------------- title bar

// The board's mirror of the attention pill; created with the filter bar.
function updateTitleBarCounts(): void {
  const total = groups().reduce((n, g) => n + g.sessions.length, 0);
  const live = groups().flatMap((g) => g.sessions).filter((s) => s.status === "running").length;
  tbCount.textContent = `${total} sessions · ${live} live`;
  const waiting = attentionCount();
  tbAttention.textContent = `${waiting} waiting on you`;
  tbAttention.classList.toggle("hidden", waiting === 0);
  const mirror = boardAttentionPill();
  if (mirror) {
    mirror.textContent = `${waiting} waiting on you`;
    mirror.classList.toggle("hidden", waiting === 0);
  }
}

registerView("titlebar", updateTitleBarCounts);

// The title bar's own controls. The layout swap itself lives in
// chrome/layout.ts; these are the buttons that ask for it.
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
      setTopInput("add");
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
      setTopInput("scan");
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
        setNewSessionProject(sectionCreateKey(label, g.id));
        expandGroup(`tier:${tier}`);
        renderSidebar();
        return;
      }
      // In a section view the create-input lives under the cursor session's
      // project sub-header within its section bucket, so scope the key to it.
      const buckets = sections();
      if (sectionView() && s && buckets) {
        const bucket = buckets.find((b) => b.session_ids.includes(s.id));
        if (bucket) {
          setNewSessionProject(sectionCreateKey(bucket.name, g.id));
          expandGroup(`sect:${bucket.name}`);
          renderSidebar();
          return;
        }
      }
      setNewSessionProject(g.id);
      expandGroup(`proj:${g.id}`);
      renderSidebar();
    },
  },
  new_project: {
    label: "Add project",
    run: () => {
      setTopInput("add");
      renderSidebar();
    },
  },
  scan_directory: {
    label: "Scan directory for repos",
    run: () => {
      setTopInput("scan");
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
