// Which view redraws, without the caller knowing who draws it.
//
// A sidebar row's menu restarts a terminal; a terminal exit re-renders the
// sidebar; a board card opens the detail panel. Wire those directly and every
// view module imports every other one, and since these modules attach
// listeners and build DOM as they load, an import cycle isn't merely untidy --
// it can leave a module half-evaluated at first use.
//
// So views register a renderer under a name and callers ask for a name. Every
// edge now points at this module, which imports nothing.
//
// Rendering is deliberately synchronous: requestRender("sidebar") does exactly
// what renderSidebar() did, at the same moment it did it, so callers that
// re-render and then focus a freshly built node still work. Coalescing
// repeated requests into one paint is a worthwhile change, but a behavioural
// one, and it isn't this.

export type View = "sidebar" | "board" | "titlebar" | "onboarding" | "tabs" | "commander";

/** Redraw order for a full refresh. The board's attention pill is built with
 *  its filter bar, so "titlebar" -- which fills that pill -- must follow it. */
const ALL: readonly View[] = ["sidebar", "board", "titlebar", "onboarding", "tabs", "commander"];

const renderers = new Map<View, () => void>();

/** Claim a view name. Each module calls this once, as it loads. */
export function registerView(view: View, render: () => void): void {
  renderers.set(view, render);
}

/** Redraw the named views now, in the order given. A view whose module hasn't
 *  loaded is skipped rather than throwing -- the boot snapshot can land before
 *  every view has registered. */
export function requestRender(...views: View[]): void {
  for (const v of views) renderers.get(v)?.();
}

/** Redraw everything, in ALL order. */
export function renderAll(): void {
  requestRender(...ALL);
}
