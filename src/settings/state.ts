// The pane's mutable state: the config draft being edited, which category is
// showing, the search query, and where focus should land after a rebuild.
//
// `working` keeps its object identity for the life of the app (replaceWorking
// clears and refills it) so every module can hold the same reference. The
// panel-redraw hook is the seam that lets a control ask for a redraw without
// importing the renderer that owns it.

import type { Config } from "./schema";

/** The config draft. Edited in place by the controls; encoded and sent on save. */
export const working: Config = {};

/** Load a fresh config into the draft, keeping the object identity. */
export function replaceWorking(config: Config): void {
  for (const k of Object.keys(working)) delete working[k];
  Object.assign(working, config);
}

let active = "general";

export function activeCat(): string {
  return active;
}

export function setActiveCat(id: string): void {
  active = id;
}

let query = "";

export function searchQuery(): string {
  return query;
}

export function setSearchQuery(q: string): void {
  query = q;
}

// When a structural re-render (add/move/remove section) should land focus on a
// specific control afterward, its selector goes here for renderPanel to honor.
let pendingFocus: string | null = null;

export function setPendingFocusSelector(sel: string | null): void {
  pendingFocus = sel;
}

/** Take the pending selector, clearing it -- a one-shot read for renderPanel. */
export function takePendingFocusSelector(): string | null {
  const sel = pendingFocus;
  pendingFocus = null;
  return sel;
}

// The content panel is rebuilt by the renderer in ./index, but the things that
// trigger a rebuild -- a gating toggle, adding a section -- live below it. They
// ask through here rather than importing upward.
let redraw: () => void = () => {};

export function registerPanelRedraw(fn: () => void): void {
  redraw = fn;
}

export function redrawPanel(): void {
  redraw();
}

/** A stable DOM id for a config field's control, so its <label> can point at it
 *  and focus can be restored to it across a panel rebuild. */
export function fieldId(path: string): string {
  return "set-" + path.replace(/[^\w-]/g, "-");
}

// ----------------------------------------------------------------- path helpers

export function getPath(obj: Config, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object") return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

export function setPath(obj: Config, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[last] = value;
}
