// The review panel's elements, and the state one open review carries.
//
// Everything below this module reads the current review from here rather than
// threading it through calls: which session, its snapshot, the selected file,
// the line selection and the keyboard cursor. The pane registry at the bottom is
// how they ask for a redraw without importing the renderers above them.

import { displayPath, type Comment, type FileDiff, type ReviewSnapshot } from "./model";
import type { PierreSelection } from "./pierre";
import { setActiveLine, setSelectedLines, teardownPierre } from "./host";

export const reviewEl = document.querySelector<HTMLDivElement>("#review")!;
export const titleEl = document.querySelector<HTMLSpanElement>("#review-title")!;
export const baseEl = document.querySelector<HTMLSpanElement>("#review-base")!;
export const statusEl = document.querySelector<HTMLSpanElement>("#review-status")!;
export const sidebarEl = document.querySelector<HTMLDivElement>("#review-sidebar")!;
export const progressEl = document.querySelector<HTMLDivElement>("#review-progress")!;
export const filesEl = document.querySelector<HTMLDivElement>("#review-files")!;
export const diffEl = document.querySelector<HTMLDivElement>("#review-diff")!;
export const applyBarEl = document.querySelector<HTMLDivElement>("#review-apply-bar")!;
export const applySummaryEl = document.querySelector<HTMLSpanElement>("#review-apply-summary")!;
export const applyEl = document.querySelector<HTMLButtonElement>("#review-apply")!;

// ------------------------------------------------------------------- state

let currentSession: string | null = null;

export function sessionId(): string | null {
  return currentSession;
}

export function setSessionId(id: string | null): void {
  currentSession = id;
}

let currentSnapshot: ReviewSnapshot | null = null;

export function snapshot(): ReviewSnapshot | null {
  return currentSnapshot;
}

export function setSnapshot(snap: ReviewSnapshot | null): void {
  currentSnapshot = snap;
}

let currentFilePath: string | null = null;

export function selectedFile(): string | null {
  return currentFilePath;
}

export function setSelectedFile(path: string | null): void {
  currentFilePath = path;
}

/** Display paths of files marked reviewed (read); mirrors the persisted store.
 *  One set for the life of the app so the file list can hold the reference. */
export const reviewed = new Set<string>();

export function replaceReviewed(paths: string[]): void {
  reviewed.clear();
  for (const p of paths) reviewed.add(p);
}

// Line selection for a new comment, in Pierre's line-number semantics (side +
// number per endpoint). The flat-line range is derived on demand.
let currentSelection: PierreSelection | null = null;

export function selection(): PierreSelection | null {
  return currentSelection;
}

export function setSelection(range: PierreSelection | null): void {
  currentSelection = range;
}

let draft = ""; // survives re-renders while extending the selection

export function draftText(): string {
  return draft;
}

export function setDraftText(text: string): void {
  draft = text;
}

// Keyboard cursor: index into the current file's flat lines. Rendered through
// Pierre's active-line decoration, so the diff is reviewable without a mouse.
// Null until the first j/k.
let currentCursor: number | null = null;

export function cursor(): number | null {
  return currentCursor;
}

export function setCursor(index: number | null): void {
  currentCursor = index;
}

// The element focused before the review opened, so closing returns focus there
// instead of dropping it to <body>.
let restoreFocus: HTMLElement | null = null;

export function setRestoreFocus(el: HTMLElement | null): void {
  restoreFocus = el;
}

// ------------------------------------------------------------------ queries

export function currentFile(): FileDiff | undefined {
  return currentSnapshot?.diff.files.find((f) => displayPath(f) === currentFilePath);
}

/** All comments anchored to `path`, regardless of whether that file (or their
 *  line) is still in the diff. */
export function commentsForFile(path: string): Comment[] {
  return currentSnapshot?.comments.filter((c) => c.file === path) ?? [];
}

export function clearSelection(): void {
  currentSelection = null;
  draft = "";
  currentCursor = null;
  setSelectedLines(null);
  setActiveLine(null);
}

export function closeReview(): void {
  currentSession = null;
  currentSnapshot = null;
  clearSelection();
  teardownPierre();
  reviewEl.classList.add("hidden");
  // Return focus to whatever opened the review (a session row action).
  restoreFocus?.focus?.();
  restoreFocus = null;
}

// ------------------------------------------------------------------- panes

/** The four independently-redrawable regions of the panel. Each renderer
 *  registers under its name as it loads, so a module low in the graph can ask
 *  for a redraw of one it doesn't import. */
export type Pane = "progress" | "files" | "diff" | "apply";

const panes = new Map<Pane, () => void>();

export function registerPane(pane: Pane, render: () => void): void {
  panes.set(pane, render);
}

export function redraw(...which: Pane[]): void {
  for (const pane of which) panes.get(pane)?.();
}

export function redrawAll(): void {
  redraw("progress", "files", "diff", "apply");
}

// Re-reading the review from the backend is the lifecycle's job (./index), but
// anything that changes it -- saving a comment, applying -- needs to trigger it.
let reload: () => Promise<void> = () => Promise.resolve();

export function registerRefresh(fn: () => Promise<void>): void {
  reload = fn;
}

export function refreshReview(): Promise<void> {
  return reload();
}
