// Which cards the Board is showing, and how they group into columns.
//
// The filters are local UI state -- a name search and a project multiselect --
// except for "hide empty columns", which persists. The column grouping reads
// the same section buckets the sidebar does, plus a catch-all for sessions in
// no section at all.

import { groups, sectionNames } from "../app/store";
import type { SessionRow } from "../app/types";
import { sessionStateKey } from "../session/glyph";

// Board layout: which cards are visible (filter pills) + a name search. Mirrors
// projectFilter's "local UI state, re-render on change" shape.
let search = "";

export function boardSearch(): string {
  return search;
}

export function setBoardSearch(q: string): void {
  search = q;
}
// Project multiselect filter: the set of selected project ids, or null for "all
// projects" (the default). Cards whose project isn't selected are hidden across
// every section column.
let projectSelection: Set<string> | null = null;

export function boardProjectFilter(): Set<string> | null {
  return projectSelection;
}

export function setBoardProjectFilter(ids: Set<string> | null): void {
  projectSelection = ids;
}
// Hide section columns with zero visible cards (persisted).
let hideEmpty = localStorage.getItem("cc-board-hide-empty") === "1";

export function hideEmptyColumns(): boolean {
  return hideEmpty;
}

export function setHideEmptyColumns(on: boolean): void {
  hideEmpty = on;
  localStorage.setItem("cc-board-hide-empty", on ? "1" : "0");
}
//
// The Board layout renders the SAME snapshot `groups` as the sidebar — one
// column per project, agent cards inside — reusing the Console helpers
// (projClass / applyStatusGlyph / sessionMenuItems / openReview /
// openTerminal). Selection is shared with the sidebar via `selectedId`.

/** Card DOM refs by session id, so updateSelectionClasses can toggle the
 *  selected border without a full rebuild. Rebuilt on every renderBoard. */
export const boardCardRefs = new Map<string, HTMLDivElement>();

/** Per-session diffstat cache, lazily filled from get_session_detail, keyed by
 *  id so a card keeps its bar across re-renders. `null` = fetched, no diff;
 *  absent = not yet fetched. */
export const boardDiffStats = new Map<string, string | null>();
export const boardDiffPending = new Set<string>();

/** Map a liveness `.dot` state class to the semantic token class the accent
 *  bar / state pill use. Keeps the board in lockstep with the dot colours
 *  without re-deriving the status logic (we read applyStatusGlyph's output). */
export function boardStateClass(s: SessionRow): string {
  return `state-${sessionStateKey(s)}`; // running → state-running, in lockstep with the dot/chip mapping
}

/** Every project id known to the current snapshot, in board order. */
export function allProjectIds(): string[] {
  return groups().map((g) => g.id);
}

/** The selected project ids, bounded to projects still present in the snapshot.
 *  null (the default) means every project — returned here as the full set. */
export function selectedProjectIds(): Set<string> {
  const all = allProjectIds();
  const chosen = boardProjectFilter();
  return chosen ? new Set(all.filter((id) => chosen.has(id))) : new Set(all);
}

/** Does a session pass the project filter? Search composes on top. */
export function boardMatchesFilter(s: SessionRow): boolean {
  const chosen = boardProjectFilter();
  return !chosen || chosen.has(s.project_id);
}

export function boardMatchesSearch(s: SessionRow): boolean {
  const q = boardSearch();
  if (!q) return true;
  return s.title.toLowerCase().includes(q.toLowerCase());
}

/** A board column: the sessions pinned to one section (or the leading "no
 *  section" catch-all), already narrowed by filter + search. `key` is the
 *  section name, or `NO_SECTION_KEY` for the catch-all. */
export type BoardSection = { key: string; name: string; sessions: SessionRow[] };

// Sentinel key for the leading catch-all column (sessions with no section pin,
// and — when no sections are configured at all — every session).
export const NO_SECTION_KEY = "\x00none";
export const NO_SECTION_LABEL = "No section";

/** All sessions across projects, bucketed into section columns and narrowed by
 *  the active filter + search. The catch-all "no section" column comes first,
 *  then one column per configured section in `sectionNames` order. */
export function boardSectionColumns(): BoardSection[] {
  const none: BoardSection = { key: NO_SECTION_KEY, name: NO_SECTION_LABEL, sessions: [] };
  const byName = new Map<string, BoardSection>();
  const cols: BoardSection[] = [none];
  for (const name of sectionNames()) {
    const col: BoardSection = { key: name, name, sessions: [] };
    byName.set(name, col);
    cols.push(col);
  }
  for (const g of groups()) {
    for (const s of g.sessions) {
      if (!(boardMatchesFilter(s) && boardMatchesSearch(s))) continue;
      const sec = s.current_section;
      (sec && byName.get(sec) ? byName.get(sec)! : none).sessions.push(s);
    }
  }
  return cols;
}

/** Lazy-fetch a session's diffstat for its card bar; fill in place when it
 *  lands. Skips while a fetch is in flight or already cached. */
