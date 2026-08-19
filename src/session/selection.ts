// The keyboard cursor over the session list.
//
// One cursor, drawn on two surfaces: the sidebar rows and the board cards
// track the same selected id, so Cmd+Opt+Up/Down moves it wherever you happen
// to be looking. This module holds the id and the visible order; each surface
// registers a callback to repaint its own idea of a cursor.

import { groups, findSession } from "../app/store";
import type { SessionRow } from "../app/types";
import { activeTerm } from "../terminal/state";
import { openTerminal } from "../terminal/attach";

// Keyboard cursor for the sidebar (the TUI's tree cursor). Session ids of
// visible rows, one array per rendered group, rebuilt on every full render.
let selectedId: string | null = null;
let visibleGroups: string[][] = [];

/** The row the keyboard cursor is on, if any. */
export function selectedSession(): string | null {
  return selectedId;
}

/** The rendered rows, one array per group, in visual order. The sidebar
 *  rebuilds this as it renders; the cursor walks it. */
export function visibleRows(): string[][] {
  return visibleGroups;
}

export function resetVisibleRows(): void {
  visibleGroups = [];
}

export function pushVisibleRows(ids: string[]): void {
  visibleGroups.push(ids);
}

// The sidebar and the board both draw the cursor, on rows and on cards. Rather
// than reach into either, this module tells whoever asked to be told.
const listeners: (() => void)[] = [];

/** Redraw the cursor whenever it moves. Called immediately on registration is
 *  NOT implied -- each surface paints its own cursor as it renders. */
export function onSelectionChange(cb: () => void): void {
  listeners.push(cb);
}

export function selectRow(id: string | null): void {
  selectedId = id;
  for (const cb of listeners) cb();
}

export function moveSelection(delta: number): void {
  const flat = visibleGroups.flat();
  if (!flat.length) return;
  const idx = selectedId ? flat.indexOf(selectedId) : -1;
  const next = idx === -1 ? (delta > 0 ? 0 : flat.length - 1) : idx + delta;
  selectRow(flat[Math.min(flat.length - 1, Math.max(0, next))]);
}

/** Jump to the first row of the next/previous group and show its terminal. */
export function moveGroup(dir: 1 | -1): void {
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
export function targetSession(): SessionRow | undefined {
  if (selectedId) {
    const s = findSession(selectedId);
    if (s) return s;
  }
  if (activeTerm()) {
    for (const g of groups()) {
      const s = g.sessions.find((x) => x.tmux_session_name === activeTerm());
      if (s) return s;
    }
  }
  return undefined;
}
