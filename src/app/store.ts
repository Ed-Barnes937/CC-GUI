// What every view reads: the latest snapshot from the backend, plus the
// GUI-owned preferences that decide how it's arranged.
//
// The backend pushes a whole Snapshot every couple of seconds and on demand.
// This module is where that lands, so views share one copy rather than each
// holding their own, and applySnapshot() is the single point where new data
// turns into a redraw.
//
// Preferences here are GUI-owned and live in localStorage, mirroring theming:
// upstream moved view mode into a TUI-private prefs store the GUI can't reach,
// so the GUI owns layout, grouping and view mode outright. The backend just
// supplies section buckets; the frontend decides what to do with them.
//
// Workspaces are scoped HERE, not per view: groups() and sections() return only
// the active workspace's projects and sessions, so every view, count and pill
// is scoped for free and a future view can't forget to filter. The few callers
// that must see everything (lookups by id or tmux name, first-run onboarding)
// use allGroups() / the find* helpers, which search every workspace.

import { renderAll, requestRender } from "./render";
import type { ProjectGroup, SectionBucket, SessionRow, Snapshot, WorkspaceEntry } from "./types";
import { activeWorkspace, inWorkspace, reconcileActiveWorkspace } from "./workspaces";

// ------------------------------------------------------------------ snapshot

const MAIN_ONLY: WorkspaceEntry[] = [{ name: null, label: "Main" }];

let groupList: ProjectGroup[] = [];
let sectionBuckets: SectionBucket[] | null = null;
let sectionNameList: string[] = [];
let commander: Snapshot["commander"] = { enabled: false, running: false };
let workspaceList: WorkspaceEntry[] = MAIN_ONLY;
let startupChoice = "last";

// The scoped views of the snapshot, computed once per (snapshot, workspace)
// rather than on each of the many groups() calls a render makes. `version`
// bumps whenever the raw data changes underneath.
let version = 0;
let scoped: {
  version: number;
  workspace: string | null;
  groups: ProjectGroup[];
  sections: SectionBucket[] | null;
} | null = null;

function scope(): NonNullable<typeof scoped> {
  const workspace = activeWorkspace();
  if (scoped && scoped.version === version && scoped.workspace === workspace) return scoped;
  const groups = groupList.filter((g) => inWorkspace(g, workspace));
  let sections: SectionBucket[] | null = null;
  if (sectionBuckets) {
    // build_sections returns every bucket (empty ones too) and orders within a
    // bucket by per-session timestamp, so dropping other workspaces' ids
    // afterwards gives exactly what filtering first would.
    const ids = new Set(groups.flatMap((g) => g.sessions.map((s) => s.id)));
    sections = sectionBuckets.map((b) => ({ ...b, session_ids: b.session_ids.filter((id) => ids.has(id)) }));
  }
  scoped = { version, workspace, groups, sections };
  return scoped;
}

/** The active workspace's projects, in snapshot order. What every view shows. */
export function groups(): ProjectGroup[] {
  return scope().groups;
}

/** Every project in every workspace. Only for callers that must see past the
 *  active workspace: lookups, first-run onboarding, workspace project counts. */
export function allGroups(): ProjectGroup[] {
  return groupList;
}

/** The section buckets, holding only the active workspace's session ids. */
export function sections(): SectionBucket[] | null {
  return scope().sections;
}

/** Every workspace, Main first, in display order (the backend's merged list). */
export function workspaces(): WorkspaceEntry[] {
  return workspaceList;
}

/** The shared startup choice: "last", "main" or a workspace name. */
export function startupWorkspace(): string {
  return startupChoice;
}

export function sectionNames(): string[] {
  return sectionNameList;
}

export function commanderStatus(): Snapshot["commander"] {
  return commander;
}

export function commanderEnabled(): boolean {
  return commander.enabled;
}

/** True once a snapshot has arrived, so boot can tell "no projects yet" from
 *  "nothing has loaded yet". */
export function hasSnapshot(): boolean {
  return loaded;
}
let loaded = false;

/** A session by id, in any workspace. */
export function findSession(id: string): SessionRow | undefined {
  for (const g of groupList) {
    const s = g.sessions.find((s) => s.id === id);
    if (s) return s;
  }
  return undefined;
}

/** A session by its tmux session name, in any workspace. */
export function findSessionByTmux(name: string): SessionRow | undefined {
  for (const g of groupList) {
    const s = g.sessions.find((s) => s.tmux_session_name === name);
    if (s) return s;
  }
  return undefined;
}

/** The project a session belongs to, in any workspace. */
export function groupOf(sessionId: string): ProjectGroup | undefined {
  return groupList.find((g) => g.sessions.some((s) => s.id === sessionId));
}

/** Whether a session is in the active workspace (shown, as opposed to merely
 *  known). */
export function sessionInScope(id: string): boolean {
  return groups().some((g) => g.sessions.some((s) => s.id === id));
}

// -------------------------------------------------------- optimistic masks

// Sessions deleted (or retitled) locally before the backend confirms, applied
// over every incoming snapshot. A mask is held until a snapshot *confirms* the
// change (session absent for a delete; new title present for a rename) -- NOT
// merely until the invoke resolves. The 2s push loop can build a snapshot just
// before our mutation lands and deliver it just after, so clearing on resolve
// alone would flash the stale row/title back until the next tick. On invoke
// error the mask is force-cleared instead.
const pendingDeletes = new Set<string>();
const pendingTitles = new Map<string, string>();

export function maskDeleted(id: string): void {
  pendingDeletes.add(id);
}

export function unmaskDeleted(id: string): void {
  pendingDeletes.delete(id);
}

export function maskTitle(id: string, title: string): void {
  pendingTitles.set(id, title);
}

export function unmaskTitle(id: string): void {
  pendingTitles.delete(id);
}

/** Drop a session from the held snapshot right away (an optimistic delete,
 *  alongside maskDeleted), so views redraw without it before the backend
 *  confirms. */
export function dropSession(id: string): void {
  for (const g of groupList) g.sessions = g.sessions.filter((s) => s.id !== id);
  if (sectionBuckets) for (const b of sectionBuckets) b.session_ids = b.session_ids.filter((x) => x !== id);
  version++;
}

function applyPendingOverlays(snap: Snapshot): void {
  if (!pendingDeletes.size && !pendingTitles.size) return;

  // Reconcile against the raw (pre-mask) snapshot: drop masks the backend has
  // caught up on, so they don't linger and suppress a later re-creation.
  const present = new Map<string, string>();
  for (const g of snap.groups) for (const s of g.sessions) present.set(s.id, s.title);
  for (const id of [...pendingDeletes]) if (!present.has(id)) pendingDeletes.delete(id);
  for (const [id, title] of [...pendingTitles]) {
    if (present.get(id) === title) pendingTitles.delete(id);
  }

  for (const g of snap.groups) {
    g.sessions = g.sessions.filter((s) => !pendingDeletes.has(s.id));
    for (const s of g.sessions) {
      const title = pendingTitles.get(s.id);
      if (title) s.title = title;
    }
  }
  if (snap.sections) {
    for (const b of snap.sections) {
      b.session_ids = b.session_ids.filter((id) => !pendingDeletes.has(id));
    }
  }
}

/** Take a snapshot and redraw. The one path from backend data to the screen. */
export function applySnapshot(snap: Snapshot): void {
  applyPendingOverlays(snap);
  groupList = snap.groups;
  // viewMode is GUI-owned (localStorage), not read back from the snapshot.
  sectionBuckets = snap.sections;
  sectionNameList = snap.section_names;
  commander = snap.commander;
  workspaceList = snap.workspaces?.length ? snap.workspaces : MAIN_ONLY;
  startupChoice = snap.startup_workspace ?? "last";
  version++;
  loaded = true;
  // A workspace deleted elsewhere falls back to Main before anything draws.
  reconcileActiveWorkspace(workspaceList);
  renderAll();
}

// --------------------------------------------------------------- preferences

const KEY_LAYOUT = "cc-layout";
const KEY_VIEW_MODE = "cc-view-mode";
const KEY_STATUS_GROUPING = "cc-status-grouping";

export type Layout = "console" | "board";

let layoutPref: Layout = (localStorage.getItem(KEY_LAYOUT) as Layout) ?? "console";
let viewModePref = localStorage.getItem(KEY_VIEW_MODE) ?? "project";
// GUI-only "Status" grouping override (the GROUP BY control's third segment):
// groups the sidebar by activity tier instead of the section/project viewMode.
// The crate's ViewMode has no status variant, so this layers over viewMode.
let statusGroupingPref = localStorage.getItem(KEY_STATUS_GROUPING) === "1";

export function layout(): Layout {
  return layoutPref;
}

/** Record the layout choice. The DOM swap that goes with it lives in the
 *  title bar, which owns both panes. */
export function setLayoutPref(next: Layout): void {
  layoutPref = next;
  localStorage.setItem(KEY_LAYOUT, next);
}

export function viewMode(): string {
  return viewModePref;
}

export function setViewModePref(mode: string): void {
  viewModePref = mode;
  localStorage.setItem(KEY_VIEW_MODE, mode);
}

export function statusGrouping(): boolean {
  return statusGroupingPref;
}

export function setStatusGrouping(on: boolean): void {
  if (on === statusGroupingPref) return;
  statusGroupingPref = on;
  localStorage.setItem(KEY_STATUS_GROUPING, on ? "1" : "0");
  requestRender("sidebar");
}

/** Section layout is active only when the GUI-owned view mode selects it AND
 *  the backend supplied section buckets (sections are always sent when
 *  configured, so project view must be gated on viewMode, not on `sections`). */
export function sectionView(): boolean {
  return sectionBuckets !== null && (viewModePref === "sections" || viewModePref === "section_stacks");
}
