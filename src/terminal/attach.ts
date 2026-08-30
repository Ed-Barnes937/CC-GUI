// Attaching a tmux session to an xterm terminal.
//
// One PTY per tmux session (pty.rs), so a session has at most one terminal:
// attaching an already-live session just activates its tab. A dead one is torn
// down and rebuilt. The Channel carries PTY output straight into xterm.

import { invoke, Channel } from "@tauri-apps/api/core";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebglAddon } from "@xterm/addon-webgl";
import { toast } from "../toast";
import { draggable } from "../drag";
import { currentTheme } from "../theme";
import { shellChip } from "../status";
import { groups } from "../app/store";
import { tabsEl, terminalsEl } from "../app/elements";
import type { ProjectGroup, SessionRow } from "../app/types";
import { syncTermOrderFromDom, terminals, type TermEntry } from "./state";
import {
  activateTerminal,
  assignPane,
  closeTerminal,
  hideSplitOverlay,
  quadrantAt,
  showSplitOverlay,
} from "./surface";
import { clearDropMarker, showDropMarker, tabBeforeX, tabNewBtn, updateTabGlyphs } from "./tabs";
import { resetRestartBudget } from "./restart";

export async function openTerminal(session: SessionRow): Promise<void> {
  // A deliberate attach resets the crash-loop guard for this session.
  resetRestartBudget(session.tmux_session_name);
  // Recreates the tmux session first if the session is stopped or its pane
  // died, matching the TUI's attach behaviour.
  await attachTerminal(session.tmux_session_name, session.title, () =>
    invoke("prepare_attach", { id: session.id }),
  );
}

/** Open the per-worktree shell terminal for a session. */
export async function openShell(session: SessionRow): Promise<void> {
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

export async function openProjectShell(group: ProjectGroup): Promise<void> {
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
export async function attachTerminal(
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

  // GPU-accelerated glyph rendering: keeps the terminal smooth when Claude's
  // TUI streams long responses across several live tabs. Loaded *after* open()
  // so xterm's initial font measurement runs against the DOM renderer with the
  // preloaded font (see above) — the WebGL addon then takes over the paint.
  // WebGL contexts can be lost (GPU reset, tab backgrounded, driver hiccup);
  // dispose the addon on loss so xterm falls back to the DOM renderer instead
  // of going blank. Skipped under the iwft simulator, whose page objects read
  // xterm's rendered text from the DOM — the canvas paint would blank it out.
  if (!("__CC_SIM__" in window)) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL renderer unavailable, using DOM fallback", e);
    }
  }

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
      const s = groups().flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name);
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
