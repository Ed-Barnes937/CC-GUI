// How a session renders as a liveness dot and a status chip.
//
// The sidebar rows, the board cards and the terminal tabs all show the same
// session state, so they all read it from here: one mapping from a SessionRow
// to a dot class, a tooltip and a chip word. status.ts holds the vocabulary
// (colours, shapes, tier order) with no knowledge of sessions; this is the
// bridge between the two.

import {
  statusChip,
  stateChipInfo,
  stateTier,
  type StatusState,
  type StatusTier,
} from "../status";
import type { SessionRow } from "../app/types";

/** Liveness-dot state classes set by applyStatusGlyph. `dot-running` carries
 *  the pulse; the rest are static colour. Removed wholesale before re-applying. */
export const STATUS_GLYPH_CLASSES = [
  "dot-running",
  "dot-finished",
  "dot-idle",
  "dot-stopped",
  "dot-transient",
  "dot-waiting",
  "dot-hibernated",
];

/** Set `el`'s liveness dot (colour/pulse/tooltip) from a session's status.
 *  Shared by the sidebar rows and the terminal tabs so they stay in lockstep.
 *  The element renders as an 8px circle (see `.dot`/.glyph/.tab-glyph CSS); the
 *  state class drives its colour and the running pulse. */
export function applyStatusGlyph(el: HTMLSpanElement, s: SessionRow): void {
  el.classList.remove(...STATUS_GLYPH_CLASSES);
  el.textContent = "";
  let cls: string;
  let title: string;
  if (s.unread) {
    // Finished while away — surface as the "finished" colour regardless of the
    // underlying agent state.
    cls = "dot-finished";
    title = "finished — needs attention";
  } else if (s.status === "running") {
    if (s.agent_state === "working") {
      cls = "dot-running";
      title = "running";
    } else if (s.agent_state === "waitingforinput") {
      // Distinct from the in-progress dot: a yellow "?" glyph, not a circle.
      cls = "dot-waiting";
      el.textContent = "?";
      title = "waiting for input";
    } else if (s.agent_state === "idle") {
      cls = "dot-idle";
      title = "idle";
    } else {
      cls = "dot-idle";
      title = s.agent_state;
    }
  } else if (s.hibernated) {
    // Auto-hibernated (status is "stopped"): a moon glyph distinct from a
    // plainly-stopped session, since it can be woken to resume its agent.
    cls = "dot-hibernated";
    el.textContent = "☾";
    title = "hibernated — wake to resume";
  } else if (s.status === "stopped") {
    cls = "dot-stopped";
    title = "stopped";
  } else {
    cls = "dot-transient"; // creating / merging / pushing / cascade_paused
    title = s.status;
  }
  el.classList.add(cls);
  el.title = title;
}

export function statusGlyph(s: SessionRow): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "glyph dot";
  applyStatusGlyph(el, s);
  return el;
}

/** Derive a session's liveness state key by reading applyStatusGlyph's own
 *  output (probe → `dot-running` → "running"), so the status chips, the board
 *  accent bar, and the terminal-tab dots all stay in lockstep with one mapping.
 *  Mirrors boardStateClass's probe. */
export function sessionStateKey(s: SessionRow): StatusState {
  const probe = document.createElement("span");
  applyStatusGlyph(probe, s);
  for (const cls of STATUS_GLYPH_CLASSES) {
    if (probe.classList.contains(cls)) return cls.slice(4) as StatusState; // dot-running → running
  }
  return "idle";
}

/** A session's activity tier for the Status grouping, via the shared state
 *  key so it stays in lockstep with the dots and chips. */
export function sessionTier(s: SessionRow): StatusTier {
  return stateTier(sessionStateKey(s));
}

/** The chip word for a session's state. Transient states (creating/merging/
 *  pushing/…) carry the humanized status rather than a fixed word. */
export function sessionStateWord(s: SessionRow, key: StatusState): string {
  return key === "transient"
    ? s.status.charAt(0).toUpperCase() + s.status.slice(1).replace(/_/g, " ")
    : stateChipInfo(key).word;
}

/** The shared shape+colour+word chip for a session's liveness state. */
export function sessionStatusChip(s: SessionRow): HTMLSpanElement {
  const key = sessionStateKey(s);
  return statusChip(key, { word: sessionStateWord(s, key) });
}
