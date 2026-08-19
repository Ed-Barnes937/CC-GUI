// The terminals that exist, and which quadrant holds what.
//
// State and the small operations that read it directly -- fit the active
// terminal, re-theme every terminal, show the placeholder when there are none.
// Anything that coordinates between attaching, splitting and docking lives in
// the modules that import this one, so those modules can share the state
// without importing each other.

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onThemeChange } from "../theme";
import { requestRender } from "../app/render";
import { placeholderEl, tabsEl } from "../app/elements";

export type TermEntry = {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  surface: HTMLDivElement; // inner element xterm renders into
  tab: HTMLDivElement;
  glyph: HTMLSpanElement;
  title: string;
  dead: boolean;
};

export const terminals = new Map<string, TermEntry>(); // keyed by tmux session name
let active: string | null = null;

/** The tmux session whose terminal is on screen (or focused, when split). */
export function activeTerm(): string | null {
  return active;
}

export function setActiveTerm(name: string | null): void {
  active = name;
}

// ------------------------------------------------------------- split panes
// Console view can show up to 4 terminals at once, dragged into quadrant drop
// zones. Layout is "columns-of-stacks": up to two columns, each an independent
// stack of up to two rows (left = [TL, BL], right = [TR, BR]). Empty columns /
// rows collapse. This avoids the unresolvable L-shapes a free 2×2 grid produces.
// One PTY per tmux session (pty.rs) ⇒ a session lives in exactly one pane;
// dropping onto an occupied slot REPLACES (the displaced session parks as a
// hidden direct child of #terminals, still alive). Split is active when
// `panes.size >= 2`; single-pane keeps the classic `activateTerminal` path.
export type Slot = "TL" | "TR" | "BL" | "BR";
export const panes = new Map<Slot, string>(); // slot -> tmux session name (split mode)
let focused: Slot | null = null;

export function focusedSlot(): Slot | null {
  return focused;
}

export function setFocusedSlot(slot: Slot | null): void {
  focused = slot;
}

// Per-quadrant accent colour: reused for the pane ring, the drop-zone preview,
// and the matching tab top-border so it's obvious which tab is on screen where.
export const SLOT_COLOR: Record<Slot, string> = {
  TL: "var(--accent)", // blue
  TR: "var(--attention)", // peach/orange
  BL: "var(--success)", // green
  BR: "var(--info)", // mauve
};

export const splitActive = (): boolean => panes.size >= 2;

/** Toggle the "select a session" placeholder for the current terminal count,
 *  and refresh the onboarding hero alongside it — the hero also gates on
 *  whether a terminal is attached (not just on project count), so attaching
 *  one (e.g. via the hero's own commander CTA) yields the hero instead of
 *  leaving it rendered on top of the newly attached terminal. */
export function updatePlaceholder(): void {
  placeholderEl.style.display = terminals.size ? "none" : "flex";
  requestRender("onboarding");
}

// Re-theme every live terminal when the GUI theme changes. The DOM renderer
// repaints automatically on an options.theme assignment.
onThemeChange((theme) => {
  for (const entry of terminals.values()) {
    entry.term.options.theme = theme.terminal;
  }
});

/** Rebuild the Map's iteration order from the current tab DOM order. */
export function syncTermOrderFromDom(): void {
  const order = [...tabsEl.querySelectorAll<HTMLDivElement>(".tab")]
    .map((t) => t.dataset.term)
    .filter((n): n is string => !!n && terminals.has(n));
  if (order.length !== terminals.size) return;
  const entries = order.map((n) => [n, terminals.get(n)!] as const);
  terminals.clear();
  for (const [n, e] of entries) terminals.set(n, e);
}

export function refitActive(): void {
  const name = activeTerm();
  if (!name) return;
  const entry = terminals.get(name);
  if (!entry) return;
  entry.fit.fit();
  void invoke("resize_pty", {
    tmuxSession: activeTerm(),
    rows: entry.term.rows,
    cols: entry.term.cols,
  });
}

// ------------------------------------------------------------- split render
// Split lives only in console layout: it re-parents the same `.term-container`
// nodes (one PTY each) into pane cells, exactly like the board dock does. A
// ResizeObserver on each cell re-fits its terminal on any size change (window,
// divider, panel). Entering board collapses the split (see setLayout).

/** First occupied slot in TL,TR,BL,BR order (fallback focus target). */
export function firstSlot(): Slot {
  return (["TL", "TR", "BL", "BR"] as Slot[]).find((s) => panes.has(s)) ?? "TL";
}

// Re-fit a terminal to its current container, batched to one rAF per frame.
