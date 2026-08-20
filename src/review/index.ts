// The review panel: opening a session's diff, and rendering the selected file.
//
// This module owns the lifecycle (open / refresh / close) and the diff pane --
// the selection, the keyboard cursor, and the options handed to Pierre. The file
// list, the comment cards, the image comparison, the apply bar and the Pierre
// component itself are beside it; they redraw through the pane registry in
// ./state rather than calling each other.

import { invoke } from "@tauri-apps/api/core";
import type { DiffLineAnnotation, FileDiffOptions } from "@pierre/diffs";
import { makeResizable } from "../resize";
import { onThemeChange } from "../theme";
import { displayPath, imageMime, type DiffLine, type FileDiff, type ReviewSnapshot } from "./model";
import { flatLines, lineAnchor, selectionToFlatRange, splitComments, type PierreSelection } from "./pierre";
import {
  applyCursor,
  claimRender,
  hydrateIfPartial,
  isStale,
  loadPierre,
  mountHolder,
  parsedFile,
  pierreTheme,
  renderPierre,
  resetCaches,
  scrollCursorIntoView,
  setSelectedLines,
  teardownPierre,
  type AnnotationMeta,
  type PierreModule,
} from "./host";
import { orphanSection, renderCommentBlock, renderCommentEditor } from "./comments";
import { renderImageDiff, resetImageCache } from "./images";
import { selectFileByOffset } from "./files";
import { disarm, isArmed, requestApply } from "./apply";
import {
  applyEl,
  baseEl,
  clearSelection,
  closeReview,
  commentsForFile,
  currentFile,
  cursor,
  diffEl,
  filesEl,
  redrawAll,
  registerPane,
  registerRefresh,
  replaceReviewed,
  reviewEl,
  selectedFile,
  selection,
  sessionId,
  setCursor,
  setDraftText,
  setRestoreFocus,
  setSelectedFile,
  setSelection,
  setSessionId,
  setSnapshot,
  sidebarEl,
  snapshot,
  statusEl,
  titleEl,
} from "./state";

export { closeReview } from "./state";

makeResizable({ key: "cc-review-files-width", target: sidebarEl, edge: "right", min: 180, max: 640 });

export async function openReview(id: string, title: string): Promise<void> {
  setSessionId(id);
  setRestoreFocus(document.activeElement as HTMLElement | null);
  titleEl.textContent = title;
  baseEl.textContent = "";
  statusEl.textContent = "";
  clearSelection();
  disarm();
  filesEl.innerHTML = "";
  teardownPierre();
  diffEl.innerHTML = '<div class="review-empty">Loading…</div>';
  reviewEl.classList.remove("hidden");
  reviewEl.focus(); // move focus into the dialog so keys and SR land here
  await refresh();
}

async function refresh(): Promise<void> {
  const id = sessionId();
  if (!id) return;
  let snap: ReviewSnapshot;
  try {
    snap = await invoke<ReviewSnapshot>("open_review", { id });
  } catch (e) {
    teardownPierre();
    diffEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "review-empty error";
    err.textContent = "Couldn't load this review. Try refreshing.";
    err.title = String(e); // raw backend error on hover, not in the face
    diffEl.appendChild(err);
    return;
  }
  if (sessionId() !== id) return; // closed or switched while loading
  setSnapshot(snap);
  replaceReviewed(snap.reviewed);
  resetCaches();
  resetImageCache();
  baseEl.textContent = `vs ${snap.base}`;
  // Keep the selection if it still points at a diff file or a stranded file
  // that still has comments; otherwise fall back to the first diff file.
  const stillSelectable =
    snap.diff.files.some((f) => displayPath(f) === selectedFile()) ||
    snap.comments.some((c) => c.file === selectedFile());
  if (!stillSelectable) {
    setSelectedFile(snap.diff.files.length ? displayPath(snap.diff.files[0]) : null);
    clearSelection();
  }
  redrawAll();
}

// Re-render on theme change: renderTextDiff hands Pierre the new theme via
// setOptions, and Pierre repaints its highlighting.
onThemeChange(() => {
  if (!sessionId()) return; // review not open
  renderDiff();
});

function renderDiff(): void {
  if (!snapshot()) return;
  const file = currentFile();
  if (!file) {
    teardownPierre();
    diffEl.innerHTML = "";
    // The selected path has no diff (its change was reverted) but may still
    // carry comments; render them so they stay visible and deletable.
    const path = selectedFile();
    const stranded = path ? commentsForFile(path) : [];
    if (stranded.length) {
      diffEl.appendChild(orphanSection(stranded));
    } else {
      const empty = document.createElement("div");
      empty.className = "review-empty";
      empty.textContent = "No changes";
      diffEl.appendChild(empty);
    }
    return;
  }
  const mime = imageMime(file);
  if (mime) {
    teardownPierre();
    void renderImageDiff(file, mime);
    return;
  }
  void renderTextDiff(file);
}

/** The full options for the Pierre pane — rebuilt per render so the theme is
 *  current (setOptions replaces, not merges). Callbacks read module state, so
 *  one instance serves every file of the open review. */
function pierreOptions(mod: PierreModule): FileDiffOptions<AnnotationMeta> {
  return {
    diffStyle: "unified",
    diffIndicators: "bars",
    disableBackground: true,
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    disableFileHeader: true, // the sidebar owns file identity
    ...pierreTheme(mod),
    enableLineSelection: true,
    // Pierre's native selection lives on the number gutter (click/drag there);
    // clicking anywhere on a line keeps working like the old renderer did.
    onLineSelected: applySelection,
    onLineClick: handleLineClick,
    renderAnnotation: (a: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = a.metadata;
      if ("kind" in meta) {
        const lines = selectionLines();
        return lines ? renderCommentEditor(lines) : undefined;
      }
      return renderCommentBlock(meta);
    },
  };
}

/** The flat lines covered by the current selection, or null when there is no
 *  selection (or it went stale against the current file). */
function selectionLines(): DiffLine[] | null {
  const file = currentFile();
  const range = file && selection() ? selectionToFlatRange(file, selection()!) : null;
  if (!file || !range) return null;
  return flatLines(file).slice(range[0], range[1] + 1);
}

/** Adopt a new selection (or none), keep the keyboard cursor in step, and
 *  re-render so the composer follows the range end. */
function applySelection(range: PierreSelection | null): void {
  if (!range) {
    if (!selection()) return;
    setSelection(null);
    setDraftText("");
    renderDiff();
    return;
  }
  const file = currentFile();
  const flat = file ? selectionToFlatRange(file, range) : null;
  if (!flat) {
    // An endpoint matches no hunk line — the drag touched expanded context,
    // which is read-only (ADR 0002). Drop the selection instead of leaving a
    // range the composer can't anchor to.
    setSelectedLines(null);
    return;
  }
  setSelection(range);
  setCursor(flat[1]);
  renderDiff();
}

/** A click on the line itself: select it for a comment (shift-click extends,
 *  clicking the sole selected line again deselects) — the old renderer's
 *  click-anywhere behaviour on top of Pierre's gutter selection. */
function handleLineClick(props: {
  lineNumber: number;
  annotationSide: "deletions" | "additions";
  lineType: "change-deletion" | "change-addition" | "context" | "context-expanded";
  event: PointerEvent;
}): void {
  // Expanded context is for reading; comments target the change (ADR 0002).
  if (props.lineType === "context-expanded") return;
  const point = { lineNumber: props.lineNumber, side: props.annotationSide };
  const current = selection();
  if (props.event.shiftKey && current) {
    applySelection({
      start: current.start,
      side: current.side,
      end: point.lineNumber,
      endSide: point.side,
    });
    return;
  }
  const soleSelected =
    current &&
    current.start === current.end &&
    current.start === point.lineNumber &&
    (current.side ?? "additions") === point.side;
  applySelection(
    soleSelected
      ? null
      : { start: point.lineNumber, side: point.side, end: point.lineNumber, endSide: point.side },
  );
}

/** Render `file` through Pierre: parse (cached), map comments to annotations,
 *  attach the composer at the selection end, and re-apply selection/cursor.
 *  Async because the module lazy-loads; a render token guards staleness. */
async function renderTextDiff(file: FileDiff): Promise<void> {
  const seq = claimRender();
  const path = displayPath(file);
  const id = sessionId();
  if (!id) return;
  const mod = await loadPierre();
  if (isStale(seq) || !sessionId() || !snapshot() || selectedFile() !== path) return;

  const meta = parsedFile(mod, file);
  if (!meta) {
    teardownPierre();
    diffEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "review-empty error";
    err.textContent = "Couldn't render this file's diff.";
    diffEl.appendChild(err);
    return;
  }

  // Hunk expansion: hydrate the parsed metadata with both sides' full contents
  // before Pierre first renders it. Awaited, so the render below already shows
  // expansion arrows; re-check staleness afterwards (file switched, refresh).
  await hydrateIfPartial(mod, id, file, meta);
  if (isStale(seq) || !sessionId() || !snapshot() || selectedFile() !== path) return;

  const snap = snapshot()!;
  const { annotations, orphans } = splitComments(snap.comments, path, file);
  const lineAnnotations: DiffLineAnnotation<AnnotationMeta>[] = annotations.map((a) => ({
    side: a.side,
    lineNumber: a.lineNumber,
    metadata: a.metadata,
  }));

  // The composer hangs off the bottom-most selected line as one more annotation.
  const flat = selection() ? selectionToFlatRange(file, selection()!) : null;
  if (flat) {
    const endLine = flatLines(file)[flat[1]];
    const anchor = lineAnchor(endLine);
    lineAnnotations.push({
      side: anchor.side,
      lineNumber: anchor.lineNumber,
      metadata: { kind: "composer", start: flat[0], end: flat[1] },
    });
  }

  // First text render (or back from an image/stranded pane): mount the holder.
  const holder = mountHolder(diffEl);
  renderPierre(mod, pierreOptions(mod), meta, lineAnnotations, holder);
  setSelectedLines(selection());
  applyCursor(file, cursor());

  // Orphaned comments render after the Pierre pane, in the page's light DOM.
  diffEl.querySelectorAll(".orphan-header, .review-comment.orphan-item").forEach((n) => n.remove());
  const frag = orphanSection(orphans);
  frag.querySelectorAll(".review-comment").forEach((n) => n.classList.add("orphan-item"));
  diffEl.appendChild(frag);
}

/** Move the keyboard line cursor by `delta` within the current file (clamped,
 *  no wrap) and keep the cursor row in view. Initialises to the first/last
 *  line when no cursor is set yet. */
function moveCursor(delta: number): void {
  const file = currentFile();
  if (!file) return;
  const count = flatLines(file).length;
  if (!count) return;
  const from = cursor() ?? (delta > 0 ? -1 : count);
  setCursor(Math.min(count - 1, Math.max(0, from + delta)));
  applyCursor(file, cursor());
  scrollCursorIntoView();
}

/** Open the comment composer for the current cursor line (the keyboard twin of
 *  clicking a line). No-op when the cursor is unset. */
function openComposerAtCursor(): void {
  const file = currentFile();
  const at = cursor();
  if (at === null || !file) return;
  const line = flatLines(file)[at];
  if (!line) return;
  const anchor = lineAnchor(line);
  setSelection({ start: anchor.lineNumber, side: anchor.side, end: anchor.lineNumber });
  renderDiff(); // the composer renders after the row and autofocuses its textarea
}

document.querySelector("#review-close")!.addEventListener("click", closeReview);
document.querySelector("#review-refresh")!.addEventListener("click", () => void refresh());
applyEl.addEventListener("click", requestApply);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || reviewEl.classList.contains("hidden")) return;
  // Unwind the most local state first: a primed Apply, then a line selection,
  // then the panel itself.
  if (isArmed()) {
    disarm();
  } else if (selection()) {
    clearSelection();
    renderDiff();
  } else {
    closeReview();
  }
});

// The review fills the screen as a modal dialog, so Tab must cycle within it
// rather than reaching the workspace behind. Wrap focus at both ends.
reviewEl.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const focusables = [
    ...reviewEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === reviewEl)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
});

// Keyboard review of the diff: j/k move a line cursor, Enter or `c` opens a
// comment for the cursor line — a full mouse-free path to leaving a comment.
document.addEventListener("keydown", (e) => {
  if (reviewEl.classList.contains("hidden")) return;
  const t = e.target as HTMLElement;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) return;
  const file = currentFile();
  if (!file || !file.hunks.length) return; // text diffs only (not images/stranded)
  if (e.key === "j") {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === "k") {
    e.preventDefault();
    moveCursor(-1);
  } else if ((e.key === "Enter" || e.key === "c") && cursor() !== null) {
    e.preventDefault();
    openComposerAtCursor();
  }
});

// File navigation: ↑/↓ and Ctrl-P/Ctrl-N move between files (matching the TUI's
// review aliases). Skipped while typing in the comment editor.
document.addEventListener("keydown", (e) => {
  if (reviewEl.classList.contains("hidden")) return;
  const t = e.target as HTMLElement;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) return;
  let delta: number;
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) delta = 1;
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) delta = -1;
  else return;
  e.preventDefault();
  selectFileByOffset(delta);
});

registerPane("diff", renderDiff);
registerRefresh(refresh);
