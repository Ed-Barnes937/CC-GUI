// Everything the app can be asked to do, and the three ways of asking:
// the command palette, the configurable keybindings, and the handful of
// accelerators that must beat xterm to the keystroke.
//
// One table, KEY_ACTIONS, backs both the palette and the bindings, and
// optional features merge their own actions into it (see features.ts), so a
// feature's keys and its help-overlay entries appear and disappear with the
// toggle rather than sitting inert.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast, confirmDialog } from "./toast";
import { adjustPanelWidth } from "./resize";
import { openReview } from "./review";
import { closeExplorer, isExplorerOpen, openExplorer } from "./fileExplorer";
import { closeMarkdownViewer, isMarkdownViewerOpen, openMarkdownViewer } from "./markdownViewer";
import { registerPaletteProvider } from "./palette";
import { setHelpKeybindings, toggleHelp } from "./help";
import { kb } from "./keys";
import {
  initKeybindings,
  loadedBindings,
  overlayOpen as keyOverlayOpen,
  rebindActions,
  reloadKeybindings,
} from "./keys";
import { openSettings } from "./settings";
import { STATUS_TIERS, stateChipInfo } from "./status";
import { setMode } from "./theme";
import { openThemeModal } from "./theme/modal";
import { featureActions, featurePalette, onFeatureChange } from "./features";
import { findSession, groupOf, groups, sectionView, sections, statusGrouping } from "./app/store";
import { invokeToast, lifecycle } from "./app/actions";
import { requestRender } from "./app/render";
import { commanderChip } from "./app/elements";
import { activeTerm, terminals } from "./terminal/state";
import { activateTabByIndex, cycleTab } from "./terminal/tabs";
import { openShell, openTerminal } from "./terminal/attach";
import { detailOpenFor, generateSummary, toggleDetail } from "./session/detail";
import { sessionStateKey, sessionStateWord, sessionTier } from "./session/glyph";
import { deleteSession, projClass, setRenamingId } from "./session/row";
import {
  moveGroup,
  moveSelection,
  selectRow,
  selectedSession,
  targetSession,
  visibleRows,
} from "./session/selection";
import {
  cycleViewMode,
  expandGroup,
  sectionCreateKey,
  setNewSessionProject,
  setTopInput,
  toggleCollapsed,
} from "./sidebar/state";
import { deleteMergedSessions } from "./sidebar/menus";
import { exportThemeTemplate, loadCustomThemes } from "./theme/custom";

export function cycleSession(delta: number): void {
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
      requestRender("sidebar");
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
      requestRender("sidebar");
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
        requestRender("sidebar");
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
          requestRender("sidebar");
          return;
        }
      }
      setNewSessionProject(g.id);
      expandGroup(`proj:${g.id}`);
      requestRender("sidebar");
    },
  },
  new_project: {
    label: "Add project",
    run: () => {
      setTopInput("add");
      requestRender("sidebar");
    },
  },
  scan_directory: {
    label: "Scan directory for repos",
    run: () => {
      setTopInput("scan");
      requestRender("sidebar");
    },
  },
  rename_session: {
    label: "Rename cursor session",
    run: () => {
      const s = targetSession();
      if (!s) return;
      setRenamingId(s.id);
      requestRender("sidebar");
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
