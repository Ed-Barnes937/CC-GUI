// The Pierre renderer: loading it, caching what it parses, and driving the one
// live component an open review keeps.
//
// Text diffs render through @pierre/diffs (unified view, bar indicators,
// word-level inline diffs, Shiki highlighting -- see docs/adr/0001). The module
// is import()ed on first review open so its highlighter and lazy language
// chunks stay out of the main bundle. Image diffs and stranded-comment sections
// are rendered by hand elsewhere.
//
// Nothing here reads the panel's state; callers pass what a call needs. That
// keeps this the bottom of the review graph -- ./state drives it, not the
// reverse.

import { invoke } from "@tauri-apps/api/core";
import type {
  DiffLineAnnotation,
  FileDiff as PierreFileDiff,
  FileDiffMetadata,
  FileDiffOptions,
} from "@pierre/diffs";
import { currentTheme, type Theme } from "../theme";
import { displayPath, type Comment, type FileDiff } from "./model";
import { assertContentMatchesHunks, buildPatch, flatLines, lineAnchor, loaderPaths, toLoadedFiles, type PierreSelection } from "./pierre";

export type PierreModule = typeof import("@pierre/diffs");

let pierrePromise: Promise<PierreModule> | null = null;

export function loadPierre(): Promise<PierreModule> {
  pierrePromise ??= import("@pierre/diffs");
  return pierrePromise;
}

/** Annotation payloads hung off diff lines: a saved comment card (the Comment
 *  itself — reference-stable per snapshot, so Pierre reuses the element), or
 *  the composer (carries its flat range so a selection change re-renders it). */
export type AnnotationMeta = Comment | { kind: "composer"; start: number; end: number };

/** Custom-theme names already registered with Pierre's highlighter. */
const registeredCustomThemes = new Set<string>();

/**
 * The Shiki theme name Pierre should render with. Built-ins carry a bundled id
 * Pierre's pinned Shiki knows; a custom theme's TextMate object is registered
 * under its id (once per app run — validateTheme forces the object's name to
 * the id, and the old renderer froze loaded themes per run the same way).
 */
function pierreThemeName(mod: PierreModule, theme: Theme): string {
  const shiki = theme.shiki;
  if (typeof shiki === "string") return shiki;
  const name = shiki.name ?? theme.id;
  if (!registeredCustomThemes.has(name)) {
    mod.registerCustomTheme(name, () => Promise.resolve(shiki));
    registeredCustomThemes.add(name);
  }
  return name;
}

/** Per-file parsed patch cache (path → Pierre metadata). Reset on refresh so a
 *  new snapshot re-parses; null marks a file Pierre couldn't parse. */
const parsedCache = new Map<string, FileDiffMetadata | null>();

export function parsedFile(mod: PierreModule, file: FileDiff): FileDiffMetadata | null {
  const path = displayPath(file);
  let meta = parsedCache.get(path);
  if (meta === undefined) {
    meta = mod.parsePatchFiles(buildPatch(file))[0]?.files[0] ?? null;
    parsedCache.set(path, meta);
  }
  return meta;
}

/** Text-content cache for hunk expansion, keyed by `${path}\0${side}`. Same
 *  lifecycle as parsedCache/imageCache: reset on snapshot refresh. */
const contentCache = new Map<string, string>();

/** Fetch one side of a text file for hunk expansion, memoized per snapshot. */
async function loadFileContents(id: string, path: string, side: "old" | "new"): Promise<string> {
  const key = `${path}\x00${side}`;
  const cached = contentCache.get(key);
  if (cached !== undefined) return cached;
  const contents = await invoke<string>("read_review_file", { id, path, side });
  contentCache.set(key, contents);
  return contents;
}

/** Metas whose hydration already ran (or failed on drift) — one attempt per
 *  parse. A snapshot refresh re-parses, so it naturally retries. */
const hydrationTried = new WeakSet<FileDiffMetadata>();

/**
 * Hydrate a partial changed/renamed file with both sides' full contents so
 * Pierre renders expansion arrows and handles the clicks itself (ADR 0002).
 * Runs before the metadata first reaches Pierre; added/deleted files are
 * skipped (their one side is already fully present in the patch). Validates
 * the snapshot's hunks against the live new-side content first — on drift the
 * file stays partial (no arrows) rather than rendering shifted context, and a
 * manual refresh recovers.
 */
export async function hydrateIfPartial(
  mod: PierreModule,
  id: string,
  file: FileDiff,
  meta: FileDiffMetadata,
): Promise<void> {
  if (!meta.isPartial || hydrationTried.has(meta)) return;
  if (meta.type !== "change" && meta.type !== "rename-changed" && meta.type !== "rename-pure")
    return;
  hydrationTried.add(meta);
  try {
    const { oldPath, newPath } = loaderPaths(meta);
    const newContents = await loadFileContents(id, newPath, "new");
    assertContentMatchesHunks(file, newContents);
    const oldContents = oldPath === null ? null : await loadFileContents(id, oldPath, "old");
    mod.hydratePartialDiff("merge", meta, toLoadedFiles(meta, oldContents, newContents));
  } catch (e) {
    console.warn(`hunk expansion unavailable for ${displayPath(file)}:`, e);
  }
}

/** Drop everything cached for the previous snapshot. Called on refresh. */
export function resetCaches(): void {
  parsedCache.clear();
  contentCache.clear();
}

// ------------------------------------------------------------- live component

// The live Pierre component + its mount point, kept for the lifetime of an
// open review so re-renders (annotations, theme) preserve scroll and state.
let pierre: PierreFileDiff<AnnotationMeta> | null = null;
let pierreHolder: HTMLDivElement | null = null;

// Monotonic render token: a render awaits the module load, so a stale call
// (file switched, review closed) must not clobber a newer one.
let renderSeq = 0;

/** Claim the render slot; the returned token is stale once another render
 *  claims it (see `isStale`). */
export function claimRender(): number {
  return ++renderSeq;
}

export function isStale(seq: number): boolean {
  return seq !== renderSeq;
}

export function teardownPierre(): void {
  pierre?.cleanUp();
  pierre = null;
  pierreHolder = null;
}

/** Mount point for the Pierre pane inside `diffEl`, (re)created when the diff
 *  area has been filled with something else (an image, a stranded comment). */
export function mountHolder(diffEl: HTMLDivElement): HTMLDivElement {
  if (!pierreHolder || !pierreHolder.isConnected || pierreHolder.parentElement !== diffEl) {
    teardownPierre();
    diffEl.innerHTML = "";
    pierreHolder = document.createElement("div");
    pierreHolder.className = "review-pierre-pane";
    diffEl.appendChild(pierreHolder);
  }
  return pierreHolder;
}

/** Render `meta` into the mounted holder, creating the component on first use
 *  and replacing its options (setOptions replaces, not merges) after that. */
export function renderPierre(
  mod: PierreModule,
  options: FileDiffOptions<AnnotationMeta>,
  meta: FileDiffMetadata,
  lineAnnotations: DiffLineAnnotation<AnnotationMeta>[],
  holder: HTMLDivElement,
): void {
  if (!pierre) pierre = new mod.FileDiff<AnnotationMeta>(options);
  else pierre.setOptions(options);
  pierre.render({ fileDiff: meta, lineAnnotations, containerWrapper: holder });
}

/** Push a selection into the component without notifying back (we are the ones
 *  who changed it). No-op before the first text render. */
export function setSelectedLines(range: PierreSelection | null): void {
  pierre?.setSelectedLines(range, { notify: false });
}

export function setActiveLine(anchor: { lineNumber: number; side: "deletions" | "additions" } | null): void {
  if (!pierre) return;
  if (!anchor) pierre.setEditorActiveLine(null);
  else pierre.setEditorActiveLine(anchor.lineNumber, { side: anchor.side });
}

/** Reflect the keyboard cursor through Pierre's active-line decoration. */
export function applyCursor(file: FileDiff, cursor: number | null): void {
  const lines = flatLines(file);
  const line = cursor !== null ? lines[cursor] : undefined;
  setActiveLine(line ? lineAnchor(line) : null);
}

/** Scroll the cursor's row (inside Pierre's shadow root) into view. */
export function scrollCursorIntoView(): void {
  const row = pierreHolder
    ?.querySelector("diffs-container")
    ?.shadowRoot?.querySelector("[data-editor-active-line]");
  row?.scrollIntoView({ block: "nearest" });
}

/** The Shiki/annotation-facing bits of the options a caller builds. */
export function pierreTheme(mod: PierreModule): { theme: string; themeType: Theme["appearance"] } {
  const theme = currentTheme();
  return { theme: pierreThemeName(mod, theme), themeType: theme.appearance };
}
