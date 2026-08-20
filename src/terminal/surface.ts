// Where the active terminal is shown: on its own, in a split pane, or docked
// under the Board.
//
// These three are one state machine, not three features. Activating a session
// while split loads it into the focused pane; dropping below two panes leaves
// split through the single-terminal path; switching to the Board moves the
// same container into the dock. Splitting them apart would only mean they
// called each other across module boundaries instead of within one.

import { invoke } from "@tauri-apps/api/core";
import { requestRender } from "../app/render";
import { groups, layout } from "../app/store";
import {
  boardDockEl,
  boardDockNameEl,
  boardDockBranchEl,
  boardDockPlaceholderEl,
  boardDockSurfaceEl,
  terminalsEl,
} from "../app/elements";
import {
  activeTerm,
  firstSlot,
  panes,
  refitActive,
  setActiveTerm,
  setFocusedSlot,
  focusedSlot,
  splitActive,
  terminals,
  updatePlaceholder,
  SLOT_COLOR,
  type Slot,
} from "./state";

// Split ratios (grow fractions), persisted; slot→session mapping is NOT.
function loadRatio(key: string): number {
  const v = Number(localStorage.getItem(key));
  return v >= 0.15 && v <= 0.85 ? v : 0.5;
}
let colRatio = loadRatio("cc-split-col"); // left column width fraction
let leftRowRatio = loadRatio("cc-split-rows-l"); // TL height within left column
let rightRowRatio = loadRatio("cc-split-rows-r"); // TR height within right column

export function activateTerminal(name: string): void {
  // Split mode: focus the pane already showing this session, else load it into
  // the focused pane (replacing whatever was there — the displaced session
  // parks but stays alive as a tab).
  if (splitActive()) {
    const slot = [...panes].find(([, n]) => n === name)?.[0];
    if (slot) focusPane(slot);
    else setPane(focusedSlot() ?? firstSlot(), name);
    return;
  }
  setActiveTerm(name);
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
    if (layout() === "board") {
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
  } else if (layout() === "board") {
    // The active terminal was just removed: refresh the dock to its placeholder.
    updateDockHeader();
  }
  requestRender("sidebar");
}

export function closeTerminal(name: string): void {
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
    if (focusedSlot() === slot) setFocusedSlot(firstSlot());
    renderPanes();
    updatePlaceholder();
    requestRender("sidebar");
    return;
  }
  if (wasSplit) {
    // Dropped below two panes: leave split, keeping the remaining session.
    exitSplit([...panes.values()][0] ?? terminals.keys().next().value ?? null);
    updatePlaceholder();
    requestRender("sidebar");
    return;
  }

  if (activeTerm() === name) {
    const next = terminals.keys().next().value ?? null;
    setActiveTerm(next);
    if (next) activateTerminal(next);
    else if (layout() === "board") updateDockHeader(); // no terminal left → dock placeholder
  }
  updatePlaceholder();
  requestRender("sidebar");
}

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

/** Whether the user has closed the dock with its "x". An explicit attach, or a
 *  fresh switch to the Board, re-docks. */
export function setDockDetached(on: boolean): void {
  dockDetached = on;
}

/** Fill the dock header (session name + branch) from the active terminal's
 *  snapshot row, toggle the placeholder vs. the docked terminal, and collapse
 *  the whole dock panel when the user has closed it with "×". */
export function updateDockHeader(): void {
  boardDockEl.classList.toggle("dock-closed", dockDetached);
  const docked = activeTerm();
  const entry = docked && !dockDetached ? terminals.get(docked) : null;
  if (!entry) {
    boardDockNameEl.textContent = "";
    boardDockBranchEl.textContent = "";
    boardDockPlaceholderEl.style.display = "flex";
    return;
  }
  const s = groups().flatMap((g) => g.sessions).find((x) => x.tmux_session_name === activeTerm());
  boardDockNameEl.textContent = s ? s.title : entry.title;
  boardDockBranchEl.textContent = s ? s.branch : "";
  boardDockPlaceholderEl.style.display = "none";
}

/** Move the active terminal's container into the dock surface and re-fit. With
 *  no active terminal (or after an explicit detach) the dock shows its
 *  placeholder. Safe to call repeatedly (re-parenting a node into its current
 *  parent is a no-op move). */
export function dockActiveTerminal(): void {
  updateDockHeader();
  const name = activeTerm();
  if (!name || dockDetached) return;
  const entry = terminals.get(name);
  if (!entry) return;
  boardDockSurfaceEl.appendChild(entry.container);
  // Mirror activateTerminal: only the active container is shown, and fit must
  // run after the move so it measures the dock surface, not #terminals.
  entry.container.classList.add("active");
  entry.fit.fit();
  void invoke("resize_pty", {
    tmuxSession: activeTerm(),
    rows: entry.term.rows,
    cols: entry.term.cols,
  });
  entry.term.focus();
}

/** Restore the active terminal's container to #terminals (Console layout) and
 *  re-fit it there. */
export function undockTerminal(): void {
  const name = activeTerm();
  if (!name) return;
  const entry = terminals.get(name);
  if (!entry) return;
  terminalsEl.appendChild(entry.container);
  refitActive();
}

const pendingFits = new Set<string>();
let fitScheduled = false;
function fitTerminal(name: string): void {
  const entry = terminals.get(name);
  if (!entry) return;
  entry.fit.fit();
  void invoke("resize_pty", { tmuxSession: name, rows: entry.term.rows, cols: entry.term.cols });
}
export function scheduleFit(name: string): void {
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
export function quadrantAt(x: number, y: number): Slot {
  const r = terminalsEl.getBoundingClientRect();
  const left = x < r.left + r.width / 2;
  const top = y < r.top + r.height / 2;
  return top ? (left ? "TL" : "TR") : left ? "BL" : "BR";
}
export function showSplitOverlay(slot: Slot): void {
  splitOverlay.classList.add("show");
  for (const s of Object.keys(dzEls) as Slot[]) dzEls[s].classList.toggle("hot", s === slot);
}
export function hideSplitOverlay(): void {
  splitOverlay.classList.remove("show");
  for (const dz of Object.values(dzEls)) dz.classList.remove("hot");
}

/** Assign a dragged session to a quadrant. From single-pane this seeds a
 *  two-pane vertical split (the on-screen session takes the opposite column),
 *  so any first drop yields left|right — the documented default. Dragging one
 *  visible pane onto another swaps the two (neither is evicted); dragging a
 *  parked tab onto an occupied slot replaces it (the occupant parks, stays alive). */
export function assignPane(slot: Slot, name: string): void {
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
    setFocusedSlot(slot);
    renderPanes();
    return;
  }

  if (srcSlot) panes.delete(srcSlot);
  if (!wasSplit) {
    const seed = activeTerm();
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
  setFocusedSlot(slot);
  renderPanes();
}

/** Load a session into a specific slot (used when clicking a parked tab in
 *  split mode); replaces the slot's current occupant, which parks but lives. */
export function setPane(slot: Slot, name: string): void {
  if (!terminals.has(name)) return;
  for (const [s, n] of [...panes]) if (n === name && s !== slot) panes.delete(s);
  panes.set(slot, name);
  if (!splitActive()) {
    exitSplit(name);
    return;
  }
  setFocusedSlot(slot);
  renderPanes();
}

/** Remove a slot from the split (via its pane's × ); the session stays alive
 *  and returns to the tab bar. Collapses to single when fewer than two remain. */
export function removePane(slot: Slot): void {
  panes.delete(slot);
  if (focusedSlot() === slot) setFocusedSlot(firstSlot());
  if (splitActive()) renderPanes();
  else exitSplit([...panes.values()][0] ?? activeTerm());
}

/** Focus a pane: sync activeTerm (for Cmd+W / targetSession / dock), move the
 *  focus ring, and focus its xterm. */
export function focusPane(slot: Slot): void {
  setFocusedSlot(slot);
  const name = panes.get(slot);
  if (name) setActiveTerm(name);
  for (const cell of terminalsEl.querySelectorAll<HTMLElement>(".pane")) {
    cell.classList.toggle("focused", cell.dataset.slot === slot);
  }
  if (name) terminals.get(name)?.term.focus();
  requestRender("sidebar");
}

/** Tag each on-screen tab with its quadrant colour (top border). */
export function updateTabPaneColors(): void {
  clearTabPaneColors();
  for (const [slot, name] of panes) {
    const entry = terminals.get(name);
    if (!entry) continue;
    entry.tab.classList.add("in-pane");
    entry.tab.style.setProperty("--pane-color", SLOT_COLOR[slot]);
  }
}
export function clearTabPaneColors(): void {
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
export function renderPanes(): void {
  if (!splitActive()) {
    exitSplit(activeTerm());
    return;
  }
  const current = focusedSlot();
  if (!current || !panes.has(current)) setFocusedSlot(firstSlot());
  if (layout() !== "console") {
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
  focusPane(focusedSlot() ?? firstSlot());
  for (const name of panes.values()) scheduleFit(name);
}

/** Leave split mode, keeping `keep` (if valid) as the single active terminal. */
export function exitSplit(keep: string | null): void {
  const target = keep && terminals.has(keep) ? keep : (terminals.keys().next().value ?? null);
  panes.clear();
  setFocusedSlot(null);
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
  setActiveTerm(null); // force activateTerminal to re-show the kept terminal
  if (target) activateTerminal(target);
  else {
    updatePlaceholder();
    if (layout() === "board") updateDockHeader();
  }
}

window.addEventListener("resize", () => {
  refitActive();
});
