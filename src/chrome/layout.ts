// Switching between the Console and the Board, and the Board dock's
// fullscreen overlay.
//
// The two surfaces share one terminal, so the swap is not just a class
// toggle: split collapses (it only exists in the Console) and the active
// terminal's container is moved into or out of the dock.

import { closeReview } from "../review";
import { makeResizable } from "../resize";
import { appEl, boardDockBackdropEl, boardDockEl, boardEl, tbBoard, tbConsole } from "../app/elements";
import { layout, setLayoutPref, type Layout } from "../app/store";
import { activeTerm, focusedSlot, panes, splitActive } from "../terminal/state";
import {
  dockActiveTerminal,
  exitSplit,
  setDockDetached,
  undockTerminal,
  updateDockHeader,
} from "../terminal/surface";

export function setLayout(next: Layout): void {
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
export function setDockFullscreen(on: boolean): void {
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

