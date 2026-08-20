// The tab strip: reordering, cycling, the "+" button, and the status dots.
//
// Tabs are the one place the terminal surface and the session list meet -- a
// tab carries a session's liveness dot and its "+" starts a new session -- so
// the coupling is stated here rather than inside the attach path.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { showContextMenu } from "../menu";
import { tabsEl } from "../app/elements";
import { registerView } from "../app/render";
import { groups } from "../app/store";
import { applyStatusGlyph } from "../session/glyph";
import { projectPickerItems } from "../session/create";
import { activeTerm, terminals } from "./state";
import { activateTerminal, closeTerminal } from "./surface";

/** The tab to insert the dragged tab before, given the pointer's x (null = end). */
export function tabBeforeX(x: number): HTMLDivElement | null {
  const tabs = [...tabsEl.querySelectorAll<HTMLDivElement>(".tab:not(.dragging)")];
  for (const tab of tabs) {
    const box = tab.getBoundingClientRect();
    if (x < box.left + box.width / 2) return tab;
  }
  return null;
}

/** Show the insertion marker before `target` (or after the last tab when null). */
export function showDropMarker(target: HTMLDivElement | null): void {
  clearDropMarker();
  if (target) {
    target.classList.add("drop-before");
  } else {
    const tabs = tabsEl.querySelectorAll<HTMLDivElement>(".tab:not(.dragging)");
    tabs[tabs.length - 1]?.classList.add("drop-after");
  }
}

export function clearDropMarker(): void {
  for (const t of tabsEl.querySelectorAll(".drop-before, .drop-after")) {
    t.classList.remove("drop-before", "drop-after");
  }
}

// "+" new-terminal button — pinned to the end of the strip. It has no
// `dataset.term`, so the drag-reorder helpers (tabBeforeX queries `.tab`,
// syncTermOrderFromDom filters by dataset.term) ignore it; the drop handler
// keeps it last by inserting dragged tabs before it.
export const tabNewBtn = document.createElement("button");
tabNewBtn.className = "tab-new";
tabNewBtn.textContent = "+";
tabNewBtn.title = "New session";
tabNewBtn.addEventListener("click", (e) => showContextMenu(e, projectPickerItems()));
tabsEl.appendChild(tabNewBtn);

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
    const name = activeTerm();
    if (name) {
      closeTerminal(name);
    } else {
      void getCurrentWindow().close();
    }
  },
  true,
);

/** Activate the open terminal tab at `index` (0-based), if it exists. */
export function activateTabByIndex(index: number): void {
  const name = [...terminals.keys()][index];
  if (name) activateTerminal(name);
}

/** Cycle the active terminal tab by `delta` (wraps around). */
export function cycleTab(delta: number): void {
  const names = [...terminals.keys()];
  if (!names.length) return;
  const name = activeTerm();
  const cur = name ? names.indexOf(name) : -1;
  activateTerminal(names[(cur + delta + names.length) % names.length]);
}

export function updateTabGlyphs(): void {
  for (const [name, entry] of terminals) {
    const s = groups().flatMap((g) => g.sessions).find((x) => x.tmux_session_name === name);
    if (s) {
      entry.glyph.hidden = false;
      applyStatusGlyph(entry.glyph, s);
    } else {
      entry.glyph.hidden = true;
    }
  }
}

registerView("tabs", updateTabGlyphs);
