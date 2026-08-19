// The attention queue: which sessions are waiting on the user, and the pills
// that count them.
//
// Two pills show the same number -- one in the title bar, one at the top of
// the Board -- and both jump to the next session that needs you. The Board's
// is built here rather than in its filter bar so the wiring lives with the
// queue it reports.

import { groups } from "../app/store";
import type { SessionRow } from "../app/types";
import { openTerminal } from "../terminal/attach";
import { sessionStateKey } from "../session/glyph";
import { selectRow, selectedSession } from "../session/selection";
import { tbAttention } from "../app/elements";
import { setLayout } from "./layout";

/** Sessions waiting on the user: the agent asked for input, or finished while
 *  away (unread) — the at-a-glance attention queue, in sidebar snapshot order.
 *  In lockstep with the status-chip vocabulary via sessionStateKey. */
export function attentionSessions(): SessionRow[] {
  return groups().flatMap((g) => g.sessions).filter((s) => {
    const key = sessionStateKey(s);
    return key === "waiting" || key === "finished";
  });
}

export function attentionCount(): number {
  return attentionSessions().length;
}

/** Jump to the next session that needs the user — select it and open its
 *  terminal — cycling through the attention queue on repeat activation, so the
 *  "N waiting on you" pill doubles as a one-key sweep of everything blocked on
 *  you. No-op when nothing waits. */
export function jumpToAttention(): void {
  const queue = attentionSessions();
  if (!queue.length) return;
  const cursor = selectedSession();
  const cur = cursor ? queue.findIndex((s) => s.id === cursor) : -1;
  const next = queue[(cur + 1) % queue.length];
  setLayout("console");
  selectRow(next.id);
  void openTerminal(next);
}

/** Make an attention pill actionable: click or Enter/Space jumps to the next
 *  session that needs you (see jumpToAttention). The title-bar markup already
 *  carries role/tabindex/aria-live; the board mirror gets them here. */
export function wireAttentionPill(el: HTMLElement): void {
  el.addEventListener("click", jumpToAttention);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      jumpToAttention();
    }
  });
}
wireAttentionPill(tbAttention);

// The Board mirrors the title-bar pill at the top of its filter bar. The
// filter bar is rebuilt on every board render, so it asks for a fresh pill
// each time and this keeps the reference the title bar fills.
let boardPill: HTMLSpanElement | null = null;

export function boardAttentionPill(): HTMLSpanElement | null {
  return boardPill;
}

/** Build the Board's attention pill, wired and hidden. The title-bar markup
 *  already carries role/tabindex/aria-live; the mirror gets them here. */
export function createBoardAttentionPill(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "board-attention hidden";
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.setAttribute("aria-live", "polite");
  el.title = "Jump to the next session that needs you";
  wireAttentionPill(el);
  boardPill = el;
  return el;
}
