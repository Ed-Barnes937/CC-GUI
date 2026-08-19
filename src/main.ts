// Boot.
//
// Everything the window does lives in a module; this wires them together and
// starts them. The order matters in one respect only: a view must have
// registered its renderer (which it does as it loads) before the first
// snapshot arrives, so the view modules are imported before the snapshot is
// fetched.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { toast } from "./toast";
import { makeResizable } from "./resize";
import { overlayOpen as keyOverlayOpen } from "./keys";
import { followSystem, initTheme } from "./theme";
import { detailEl, sessionsEl } from "./app/elements";
import { applySnapshot, hasSnapshot } from "./app/store";
import type { Snapshot } from "./app/types";
import { activeTerm, refitActive, terminals } from "./terminal/state";
import { closeDetail, detailOpenFor } from "./session/detail";
import { selectRow, selectedSession } from "./session/selection";

// The view modules. Each registers its renderer with app/render.ts as it
// loads, and wires its own listeners; nothing here calls into them.
import "./terminal/restart";
import "./sidebar/index";
import "./board/index";
import "./chrome/titlebar";
import "./chrome/commander";
import "./chrome/onboarding";
import "./commands";
import "./theming";
import "./featureList";

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

// The two side panels are drag-resizable; the terminal refits as they move.
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

// Esc dismisses the detail panel when it's open, else clears the keyboard
// cursor (overlays handle their own Esc).
document.addEventListener("keydown", (e) => {
  const inTerminal = (e.target as HTMLElement).closest(".xterm");
  if (e.key !== "Escape" || keyOverlayOpen() || inTerminal) return;
  if (detailOpenFor()) closeDetail();
  else if (selectedSession()) selectRow(null);
});

// The backend pushes a snapshot every couple of seconds; this fetch covers the
// gap before the first push.
void listen<Snapshot>("sessions-updated", (event) => applySnapshot(event.payload));

invoke<Snapshot>("get_groups")
  .then((snap) => {
    // The push loop may have rendered already; don't regress its richer data.
    if (!hasSnapshot()) applySnapshot(snap);
  })
  .catch((e) => {
    sessionsEl.innerHTML = `<div class="error">Error: ${e}</div>`;
  });
