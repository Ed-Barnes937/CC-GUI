import { invoke } from "@tauri-apps/api/core";
import type {
  DiffLineAnnotation,
  FileDiff as PierreFileDiff,
  FileDiffMetadata,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs";
import { noTextAssist } from "./dom";
import { makeResizable } from "./resize";
import { toast } from "./toast";
import { currentTheme, onThemeChange, type Theme } from "./theme";
import {
  buildDraft,
  describeOutcome,
  displayPath,
  imageMime,
  STATUS_LETTER,
  type ApplyOutcome,
  type Comment,
  type DiffLine,
  type FileDiff,
  type ReviewSnapshot,
} from "./review/model";
import {
  buildPatch,
  composerAnchor,
  flatLines,
  selectionToFlatRange,
  splitComments,
  type PierreSelection,
} from "./review/pierre";

// ------------------------------------------------------------ pierre renderer
//
// Text diffs render through @pierre/diffs (unified view, bar indicators,
// word-level inline diffs, Shiki highlighting — see docs/adr/0001). The module
// is import()ed on first review open so its highlighter and lazy language
// chunks stay out of the main bundle. Image diffs and stranded-comment
// sections keep their custom rendering below.

type PierreModule = typeof import("@pierre/diffs");

let pierrePromise: Promise<PierreModule> | null = null;

function loadPierre(): Promise<PierreModule> {
  pierrePromise ??= import("@pierre/diffs");
  return pierrePromise;
}

/** Annotation payloads hung off diff lines: a saved comment card (the Comment
 *  itself — reference-stable per snapshot, so Pierre reuses the element), or
 *  the composer (carries its flat range so a selection change re-renders it). */
type AnnotationMeta = Comment | { kind: "composer"; start: number; end: number };

/** Custom-theme names already registered with Pierre's highlighter. */
const registeredCustomThemes = new Set<string>();

/**
 * The Shiki theme name Pierre should render with. Built-ins carry a bundled id
 * Pierre's pinned Shiki knows; a custom theme's TextMate object is registered
 * under its id (once — validateTheme forces the object's name to the id).
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

function parsedFile(mod: PierreModule, file: FileDiff): FileDiffMetadata | null {
  const path = displayPath(file);
  let meta = parsedCache.get(path);
  if (meta === undefined) {
    meta = mod.parsePatchFiles(buildPatch(file))[0]?.files[0] ?? null;
    parsedCache.set(path, meta);
  }
  return meta;
}

/** Image data-URL cache, keyed by `${path}\0${side}`. Reset on refresh so a new
 *  snapshot re-reads the bytes; avoids re-fetching on theme change / re-render. */
const imageCache = new Map<string, string>();

const reviewEl = document.querySelector<HTMLDivElement>("#review")!;
const titleEl = document.querySelector<HTMLSpanElement>("#review-title")!;
const baseEl = document.querySelector<HTMLSpanElement>("#review-base")!;
const statusEl = document.querySelector<HTMLSpanElement>("#review-status")!;
const sidebarEl = document.querySelector<HTMLDivElement>("#review-sidebar")!;
const progressEl = document.querySelector<HTMLDivElement>("#review-progress")!;
const filesEl = document.querySelector<HTMLDivElement>("#review-files")!;
const diffEl = document.querySelector<HTMLDivElement>("#review-diff")!;
const applyBarEl = document.querySelector<HTMLDivElement>("#review-apply-bar")!;
const applySummaryEl = document.querySelector<HTMLSpanElement>("#review-apply-summary")!;
const applyEl = document.querySelector<HTMLButtonElement>("#review-apply")!;

makeResizable({ key: "cc-review-files-width", target: sidebarEl, edge: "right", min: 180, max: 640 });

let sessionId: string | null = null;
let snapshot: ReviewSnapshot | null = null;
let selectedFile: string | null = null;

// Display paths of files marked reviewed (read); mirrors the persisted store.
let reviewed = new Set<string>();

// Line selection for a new comment, in Pierre's line-number semantics (side +
// number per endpoint). The flat-line range is derived on demand.
let selection: PierreSelection | null = null;
let draftText = ""; // survives re-renders while extending the selection
let applying = false;

// Keyboard cursor: index into the current file's flat lines. Rendered through
// Pierre's active-line decoration, so the diff is reviewable without a mouse.
// Null until the first j/k.
let cursor: number | null = null;

// Apply is irreversible (it hands the comments to the agent), so the button
// arms on the first press and only sends on the second. Auto-disarms after a
// short window so a stray click never leaves it primed.
let armed = false;
let armTimer: number | null = null;

// The element focused before the review opened, so closing returns focus there
// instead of dropping it to <body>.
let restoreFocus: HTMLElement | null = null;

// The live Pierre component + its mount point, kept for the lifetime of an
// open review so re-renders (annotations, theme) preserve scroll and state.
let pierre: PierreFileDiff<AnnotationMeta> | null = null;
let pierreHolder: HTMLDivElement | null = null;

// Monotonic render token: renderTextDiff awaits the module load, so a stale
// call (file switched, review closed) must not clobber a newer render.
let renderSeq = 0;

function teardownPierre(): void {
  pierre?.cleanUp();
  pierre = null;
  pierreHolder = null;
}

export async function openReview(id: string, title: string): Promise<void> {
  sessionId = id;
  restoreFocus = document.activeElement as HTMLElement | null;
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
  if (!sessionId) return;
  const id = sessionId;
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
  if (sessionId !== id) return; // closed or switched while loading
  snapshot = snap;
  reviewed = new Set(snap.reviewed);
  parsedCache.clear();
  imageCache.clear();
  baseEl.textContent = `vs ${snap.base}`;
  // Keep the selection if it still points at a diff file or a stranded file
  // that still has comments; otherwise fall back to the first diff file.
  const stillSelectable =
    snap.diff.files.some((f) => displayPath(f) === selectedFile) ||
    snap.comments.some((c) => c.file === selectedFile);
  if (!stillSelectable) {
    selectedFile = snap.diff.files.length ? displayPath(snap.diff.files[0]) : null;
    clearSelection();
  }
  renderProgress();
  renderFiles();
  renderDiff();
  renderApply();
}

// Re-render on theme change: renderTextDiff hands Pierre the new theme via
// setOptions, and Pierre repaints its highlighting.
onThemeChange(() => {
  if (!sessionId) return; // review not open
  renderDiff();
});

export function closeReview(): void {
  sessionId = null;
  snapshot = null;
  clearSelection();
  disarm();
  teardownPierre();
  reviewEl.classList.add("hidden");
  // Return focus to whatever opened the review (a session row action).
  restoreFocus?.focus?.();
  restoreFocus = null;
}

function clearSelection(): void {
  selection = null;
  draftText = "";
  cursor = null;
  pierre?.setSelectedLines(null, { notify: false });
  pierre?.setEditorActiveLine(null);
}

function currentFile(): FileDiff | undefined {
  return snapshot?.diff.files.find((f) => displayPath(f) === selectedFile);
}

/** All comments anchored to `path`, regardless of whether that file (or their
 *  line) is still in the diff. */
function commentsForFile(path: string): Comment[] {
  return snapshot?.comments.filter((c) => c.file === path) ?? [];
}

/** Toggle the reviewed mark for a file (persisted via the backend) and reflect
 *  it in the local mirror + file list. */
async function toggleReviewed(path: string): Promise<void> {
  if (!sessionId) return;
  let now: boolean;
  try {
    now = await invoke<boolean>("toggle_file_reviewed", { id: sessionId, path });
  } catch (e) {
    toast("Couldn't update the reviewed mark.", "error", String(e));
    return;
  }
  if (now) reviewed.add(path);
  else reviewed.delete(path);
  renderProgress();
  renderFiles();
}

/** Move the file selection by `delta` (clamped at the ends, no wrap) and keep
 *  the newly selected row visible. Backs the Ctrl-N/P and arrow navigation. */
function selectFileByOffset(delta: number): void {
  const files = snapshot?.diff.files;
  if (!files || !files.length) return;
  const cur = files.findIndex((f) => displayPath(f) === selectedFile);
  const next = Math.min(files.length - 1, Math.max(0, (cur === -1 ? 0 : cur) + delta));
  const path = displayPath(files[next]);
  if (path === selectedFile) return;
  selectedFile = path;
  clearSelection();
  renderFiles();
  renderDiff();
  filesEl.querySelector(".review-file.active")?.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------------- files

/** The "N/total files reviewed" progress ring above the file list, filled
 *  proportionally to the reviewed count. Hidden when there's no diff. */
function renderProgress(): void {
  progressEl.innerHTML = "";
  const files = snapshot?.diff.files ?? [];
  const total = files.length;
  progressEl.style.display = total ? "" : "none";
  if (!total) return;
  // Count only reviewed paths still present in the diff — the stored set can
  // hold stale paths after a refresh, which would overflow the ring.
  const done = files.filter((f) => reviewed.has(displayPath(f))).length;
  const pct = Math.round((done / total) * 100);

  const wrap = document.createElement("div");
  wrap.className = "review-progress";

  const ring = document.createElement("span");
  ring.className = "progress-ring";
  ring.style.background = `conic-gradient(var(--success) ${pct}%, var(--border) 0)`;
  const count = document.createElement("span");
  count.className = "progress-ring-count";
  count.textContent = `${done}/${total}`;
  ring.appendChild(count);

  const label = document.createElement("span");
  label.className = "progress-label";
  label.textContent = "Files reviewed";

  wrap.append(ring, label);
  progressEl.appendChild(wrap);
}

function renderFiles(): void {
  filesEl.innerHTML = "";
  if (!snapshot) return;
  const commentCounts = new Map<string, number>();
  for (const c of snapshot.comments) {
    commentCounts.set(c.file, (commentCounts.get(c.file) ?? 0) + 1);
  }
  // Diff files arrive path-sorted, so same-directory files are contiguous:
  // emit a directory header whenever the dirname changes and show basenames.
  let lastDir: string | null = null;
  for (const f of snapshot.diff.files) {
    const path = displayPath(f);
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    if (dir !== lastDir) {
      lastDir = dir;
      const header = document.createElement("div");
      header.className = "review-dir";
      header.textContent = dir === "" ? "./" : `${dir}/`;
      header.title = header.textContent;
      filesEl.appendChild(header);
    }

    const row = document.createElement("div");
    row.className = "review-file";
    row.classList.toggle("active", path === selectedFile);
    const isReviewed = reviewed.has(path);
    row.classList.toggle("reviewed", isReviewed);

    const tick = document.createElement("span");
    tick.className = "file-reviewed-toggle";
    tick.textContent = isReviewed ? "✓" : "";
    tick.title = isReviewed ? "Mark as not reviewed" : "Mark as reviewed";
    tick.addEventListener("click", (e) => {
      e.stopPropagation(); // toggling reviewed shouldn't also open the diff
      void toggleReviewed(path);
    });

    const status = document.createElement("span");
    status.className = `file-status file-${f.status}`;
    status.textContent = STATUS_LETTER[f.status];

    const name = document.createElement("span");
    name.className = "file-path";
    name.textContent = path.slice(slash + 1);
    name.title = f.status === "renamed" ? `${f.old_path} → ${f.new_path}` : path;

    const counts = document.createElement("span");
    counts.className = "file-counts";
    const comments = commentCounts.get(path);
    if (comments) {
      const c = document.createElement("span");
      c.className = "file-comments";
      c.textContent = `🗨${comments}`;
      counts.appendChild(c);
    }
    const added = document.createElement("span");
    added.className = "added";
    added.textContent = `+${f.added}`;
    const removed = document.createElement("span");
    removed.className = "removed";
    removed.textContent = `-${f.removed}`;
    counts.append(added, removed);

    row.append(tick, status, name, counts);
    row.addEventListener("click", () => {
      selectedFile = path;
      clearSelection();
      renderFiles();
      renderDiff();
    });
    filesEl.appendChild(row);
  }

  // Files that have comments but are no longer in the diff (their change was
  // reverted) never get a row above, so their comments would be unreachable.
  // List them in a trailing section, keeping them selectable and deletable.
  const diffPaths = new Set(snapshot.diff.files.map(displayPath));
  const strandedFiles = [...new Set(snapshot.comments.map((c) => c.file))]
    .filter((p) => !diffPaths.has(p))
    .sort();
  if (strandedFiles.length) {
    const header = document.createElement("div");
    header.className = "review-dir stranded-dir";
    header.textContent = "no longer in the diff";
    header.title = "Files with comments whose change is no longer in the diff";
    filesEl.appendChild(header);
    for (const path of strandedFiles) {
      filesEl.appendChild(strandedFileRow(path, commentCounts.get(path) ?? 0));
    }
  }

  if (!snapshot.diff.files.length && !strandedFiles.length) {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.textContent = "No changes";
    filesEl.appendChild(empty);
  }
}

/** A file-list row for a path that has comments but is no longer in the diff:
 *  no reviewed toggle or +/- stats (there's no diff), just a marker, the name,
 *  and the comment count. Selecting it renders the stranded comments. */
function strandedFileRow(path: string, count: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "review-file stranded";
  row.classList.toggle("active", path === selectedFile);
  const slash = path.lastIndexOf("/");

  const status = document.createElement("span");
  status.className = "file-status file-stranded";
  status.textContent = "!";

  const name = document.createElement("span");
  name.className = "file-path";
  name.textContent = path.slice(slash + 1);
  name.title = path;

  const counts = document.createElement("span");
  counts.className = "file-counts";
  if (count) {
    const c = document.createElement("span");
    c.className = "file-comments";
    c.textContent = `🗨${count}`;
    counts.appendChild(c);
  }

  row.append(status, name, counts);
  row.addEventListener("click", () => {
    selectedFile = path;
    clearSelection();
    renderFiles();
    renderDiff();
  });
  return row;
}

// ---------------------------------------------------------------- comments

/** The "y" avatar + "you" + status tag row shared by a saved comment card and
 *  the open composer (which reads "staged" ahead of the save that makes it so). */
function commentHead(status: Comment["status"]): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "comment-head";
  const avatar = document.createElement("span");
  avatar.className = "comment-avatar";
  avatar.textContent = "y";
  const who = document.createElement("span");
  who.className = "comment-who";
  who.textContent = "you";
  const tag = document.createElement("span");
  tag.className = `comment-tag comment-${status}`;
  tag.textContent = status;
  head.append(avatar, who, tag);
  return head;
}

function renderCommentBlock(c: Comment): HTMLDivElement {
  const block = document.createElement("div");
  block.className = `review-comment comment-${c.status}`;
  const head = commentHead(c.status);
  const range = document.createElement("span");
  range.className = "comment-range";
  const [start, end] = c.line_range;
  range.textContent = `${c.side} ${start === end ? start : `${start}–${end}`}`;
  head.appendChild(range);
  if (c.status !== "applied") {
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const del = document.createElement("button");
    del.className = "comment-delete";
    del.textContent = "✕";
    del.title = "Delete comment";
    del.addEventListener("click", () => void deleteComment(c.id));
    head.append(spacer, del);
  }
  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = c.comment;
  block.append(head, body);
  return block;
}

async function deleteComment(commentId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await invoke("delete_comment", { id: sessionId, commentId });
  } catch (e) {
    toast("Couldn't delete the comment.", "error", String(e));
    return;
  }
  await refresh();
}

/**
 * Build the comment draft from the selected lines, mirroring the TUI's
 * `build_draft`: the New side wins unless the selection is purely deletions,
 * and the snippet/line range come from that side's lines only.
 */
async function saveComment(lines: DiffLine[], comment: string): Promise<void> {
  const file = currentFile();
  if (!sessionId || !file || !comment.trim()) return;
  const draft = buildDraft(lines);
  if (!draft) return;
  try {
    await invoke("create_comment", {
      id: sessionId,
      file: displayPath(file),
      side: draft.side,
      lineRange: draft.lineRange,
      snippet: draft.snippet,
      comment: comment.trim(),
    });
  } catch (e) {
    toast("Couldn't save the comment.", "error", String(e));
    return;
  }
  clearSelection();
  await refresh();
}

function renderCommentEditor(lines: DiffLine[]): HTMLDivElement {
  const box = document.createElement("div");
  box.className = "review-comment editor comment-staged";
  const draft = buildDraft(lines);
  const head = commentHead("staged");
  const tag = head.querySelector<HTMLSpanElement>(".comment-tag")!;
  if (draft) {
    const [start, end] = draft.lineRange;
    tag.textContent = `staged · ${start === end ? `line ${end}` : `lines ${start}–${end}`}`;
  }
  box.appendChild(head);

  const textarea = noTextAssist(document.createElement("textarea"));
  textarea.placeholder = "Leave a comment for the agent… (Cmd/Ctrl+Enter to save, Esc to cancel)";
  textarea.rows = 3;
  textarea.value = draftText;
  textarea.addEventListener("input", () => {
    draftText = textarea.value;
  });
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep Esc from closing the whole review view
    if (e.key === "Escape") {
      clearSelection();
      renderDiff();
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void saveComment(lines, textarea.value);
    }
  });

  const buttons = document.createElement("div");
  buttons.className = "editor-buttons";
  const save = document.createElement("button");
  save.className = "editor-save";
  save.textContent = "Save ⌘↵";
  save.addEventListener("click", () => void saveComment(lines, textarea.value));
  const cancel = document.createElement("button");
  cancel.className = "editor-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    clearSelection();
    renderDiff();
  });
  buttons.append(save, cancel);

  box.append(textarea, buttons);
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 0);
  return box;
}

// -------------------------------------------------------------------- diff

/** Build a trailing section for comments that don't anchor to any rendered
 *  line — their anchor line, or whole file, has left the diff. Keeps them
 *  visible and deletable instead of silently dropping them. Mirrors
 *  claude-commander's TUI orphan handling. */
function orphanSection(orphans: Comment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!orphans.length) return frag;
  const header = document.createElement("div");
  header.className = "hunk-header orphan-header";
  header.textContent = "Unanchored comments — lines no longer in the diff";
  frag.appendChild(header);
  for (const c of orphans) frag.appendChild(renderCommentBlock(c));
  return frag;
}

function renderDiff(): void {
  if (!snapshot) return;
  const file = currentFile();
  if (!file) {
    teardownPierre();
    diffEl.innerHTML = "";
    // The selected path has no diff (its change was reverted) but may still
    // carry comments; render them so they stay visible and deletable.
    const stranded = selectedFile ? commentsForFile(selectedFile) : [];
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
  const theme = currentTheme();
  return {
    diffStyle: "unified",
    diffIndicators: "bars",
    disableBackground: true,
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    disableFileHeader: true, // the sidebar owns file identity
    theme: pierreThemeName(mod, theme),
    themeType: theme.appearance,
    enableLineSelection: true,
    onLineSelected: handleLineSelected,
    // Pierre's native selection lives on the number gutter (click/drag there);
    // clicking anywhere on a line keeps working like the old renderer did.
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
  if (!file || !selection) return null;
  const range = selectionToFlatRange(file, selection);
  if (!range) return null;
  return flatLines(file).slice(range[0], range[1] + 1);
}

/** Adopt a new selection (or none), keep the keyboard cursor in step, and
 *  re-render so the composer follows the range end. */
function applySelection(range: PierreSelection | null): void {
  if (!range) {
    if (!selection) return;
    selection = null;
    draftText = "";
    renderDiff();
    return;
  }
  selection = range;
  const file = currentFile();
  const flat = file ? selectionToFlatRange(file, selection) : null;
  if (flat) cursor = flat[1];
  renderDiff();
}

/** Pierre's committed gutter selection (click or drag on the line numbers). */
function handleLineSelected(range: SelectedLineRange | null): void {
  applySelection(range);
}

/** A click on the line itself: select it for a comment (shift-click extends,
 *  clicking the sole selected line again deselects) — the old renderer's
 *  click-anywhere behaviour on top of Pierre's gutter selection. */
function handleLineClick(props: {
  lineNumber: number;
  annotationSide: "deletions" | "additions";
  event: PointerEvent;
}): void {
  const point = { lineNumber: props.lineNumber, side: props.annotationSide };
  if (props.event.shiftKey && selection) {
    applySelection({
      start: selection.start,
      side: selection.side,
      end: point.lineNumber,
      endSide: point.side,
    });
    return;
  }
  const soleSelected =
    selection &&
    selection.start === selection.end &&
    selection.start === point.lineNumber &&
    (selection.side ?? "additions") === point.side;
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
  const seq = ++renderSeq;
  const path = displayPath(file);
  const mod = await loadPierre();
  if (seq !== renderSeq || !sessionId || !snapshot || selectedFile !== path) return;

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

  const { annotations, orphans } = splitComments(snapshot.comments, path, file);
  const lineAnnotations: DiffLineAnnotation<AnnotationMeta>[] = annotations.map((a) => ({
    side: a.side,
    lineNumber: a.lineNumber,
    metadata: a.metadata,
  }));

  // The composer hangs off the bottom-most selected line as one more annotation.
  const flat = selectionToFlatRange(file, selection ?? { start: -1, end: -1 });
  if (selection && flat) {
    const endLine = flatLines(file)[flat[1]];
    const anchor = composerAnchor(endLine);
    lineAnnotations.push({
      side: anchor.side,
      lineNumber: anchor.lineNumber,
      metadata: { kind: "composer", start: flat[0], end: flat[1] },
    });
  }

  // First text render (or back from an image/stranded pane): mount the holder.
  if (!pierreHolder || !pierreHolder.isConnected || pierreHolder.parentElement !== diffEl) {
    teardownPierre();
    diffEl.innerHTML = "";
    pierreHolder = document.createElement("div");
    pierreHolder.className = "review-pierre-pane";
    diffEl.appendChild(pierreHolder);
  }
  if (!pierre) {
    pierre = new mod.FileDiff<AnnotationMeta>(pierreOptions(mod));
  } else {
    pierre.setOptions(pierreOptions(mod));
  }
  pierre.render({ fileDiff: meta, lineAnnotations, containerWrapper: pierreHolder });
  pierre.setSelectedLines(selection, { notify: false });
  applyCursor(file);

  // Orphaned comments render after the Pierre pane, in the page's light DOM.
  diffEl.querySelectorAll(".orphan-header, .review-comment.orphan-item").forEach((n) => n.remove());
  const frag = orphanSection(orphans);
  frag.querySelectorAll(".review-comment").forEach((n) => n.classList.add("orphan-item"));
  diffEl.appendChild(frag);
}

/** Reflect the keyboard cursor through Pierre's active-line decoration. */
function applyCursor(file: FileDiff): void {
  if (!pierre) return;
  const lines = flatLines(file);
  const line = cursor !== null ? lines[cursor] : undefined;
  if (!line) {
    pierre.setEditorActiveLine(null);
    return;
  }
  const anchor = composerAnchor(line);
  pierre.setEditorActiveLine(anchor.lineNumber, { side: anchor.side });
}

/** Scroll the cursor's row (inside Pierre's shadow root) into view. */
function scrollCursorIntoView(): void {
  const row = pierreHolder
    ?.querySelector("diffs-container")
    ?.shadowRoot?.querySelector("[data-editor-active-line]");
  row?.scrollIntoView({ block: "nearest" });
}

/** Move the keyboard line cursor by `delta` within the current file (clamped,
 *  no wrap) and keep the cursor row in view. Initialises to the first/last
 *  line when no cursor is set yet. */
function moveCursor(delta: number): void {
  const file = currentFile();
  if (!file) return;
  const count = flatLines(file).length;
  if (!count) return;
  const from = cursor ?? (delta > 0 ? -1 : count);
  cursor = Math.min(count - 1, Math.max(0, from + delta));
  applyCursor(file);
  scrollCursorIntoView();
}

/** Open the comment composer for the current cursor line (the keyboard twin of
 *  clicking a line). No-op when the cursor is unset. */
function openComposerAtCursor(): void {
  const file = currentFile();
  if (cursor === null || !file) return;
  const line = flatLines(file)[cursor];
  if (!line) return;
  const anchor = composerAnchor(line);
  selection = { start: anchor.lineNumber, side: anchor.side, end: anchor.lineNumber };
  renderDiff(); // the composer renders after the row and autofocuses its textarea
}

// ------------------------------------------------------------------ images

/** Fetch one side of an image as a data URL, memoized for this snapshot. */
async function loadImage(
  id: string,
  path: string,
  side: "old" | "new",
  mime: string,
): Promise<string> {
  const key = `${path}\x00${side}`;
  const cached = imageCache.get(key);
  if (cached) return cached;
  const b64 = await invoke<string>("read_review_image", { id, path, side });
  const url = `data:${mime};base64,${b64}`;
  imageCache.set(key, url);
  return url;
}

/**
 * Render an image file as a before/after comparison instead of text hunks.
 * Added files show only the working image, deleted only the base, and modified
 * files a juxtapose slider. Async because it reads the bytes from the backend;
 * guards against the file/session changing while loading.
 */
async function renderImageDiff(file: FileDiff, mime: string): Promise<void> {
  const id = sessionId;
  const path = displayPath(file);
  if (!id) return;

  const needOld = file.status !== "added";
  const needNew = file.status !== "deleted";
  // A rename moves the blob, so each side lives at its own path; for every
  // other status old_path === new_path.
  const oldPath = file.old_path;
  const newPath = file.new_path;
  const someUncached =
    (needOld && !imageCache.has(`${oldPath}\x00old`)) ||
    (needNew && !imageCache.has(`${newPath}\x00new`));
  if (someUncached) diffEl.innerHTML = '<div class="review-empty">Loading image…</div>';

  let oldUrl: string | null = null;
  let newUrl: string | null = null;
  try {
    if (needOld) oldUrl = await loadImage(id, oldPath, "old", mime);
    if (needNew) newUrl = await loadImage(id, newPath, "new", mime);
  } catch (e) {
    if (sessionId !== id || selectedFile !== path) return;
    diffEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "review-empty error";
    err.textContent = "Couldn't load this image.";
    err.title = String(e); // raw backend error on hover, not in the face
    diffEl.appendChild(err);
    return;
  }
  if (sessionId !== id || selectedFile !== path) return; // switched away while loading

  diffEl.innerHTML = "";
  const pane = document.createElement("div");
  pane.className = "review-image-pane";
  if (oldUrl && newUrl) pane.appendChild(buildJuxtapose(oldUrl, newUrl));
  else if (newUrl) pane.appendChild(buildSingleImage(newUrl, "added (working)"));
  else if (oldUrl) pane.appendChild(buildSingleImage(oldUrl, "deleted (base)"));
  diffEl.appendChild(pane);
}

function buildSingleImage(url: string, label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "review-image single";
  const img = document.createElement("img");
  img.src = url;
  img.alt = label;
  const cap = document.createElement("span");
  cap.className = "ji-label";
  cap.textContent = label;
  wrap.append(img, cap);
  return wrap;
}

/** A juxtapose slider: working image underneath, base clipped on top, with a
 *  draggable (and arrow-key-able) divider wiping between them. */
function buildJuxtapose(oldUrl: string, newUrl: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "review-image juxtapose";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "slider");
  wrap.setAttribute("aria-label", "Image comparison — drag or use arrow keys to wipe");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "100");

  const baseImg = document.createElement("img"); // bottom layer = working (new)
  baseImg.className = "ji-base";
  baseImg.src = newUrl;
  baseImg.alt = "working";

  const overlay = document.createElement("img"); // top layer = base (old), clipped
  overlay.className = "ji-overlay";
  overlay.src = oldUrl;
  overlay.alt = "base";

  const divider = document.createElement("div");
  divider.className = "ji-divider";
  const handle = document.createElement("div");
  handle.className = "ji-handle";
  divider.appendChild(handle);

  const labelOld = document.createElement("span");
  labelOld.className = "ji-label ji-label-old";
  labelOld.textContent = "base";
  const labelNew = document.createElement("span");
  labelNew.className = "ji-label ji-label-new";
  labelNew.textContent = "working";

  wrap.append(baseImg, overlay, divider, labelOld, labelNew);

  let pos = 50;
  const apply = (): void => {
    overlay.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    divider.style.left = `${pos}%`;
    wrap.setAttribute("aria-valuenow", String(Math.round(pos)));
  };
  apply();

  const setFromX = (clientX: number): void => {
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0) return;
    pos = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    apply();
  };

  let dragging = false;
  wrap.addEventListener("pointerdown", (e) => {
    dragging = true;
    wrap.setPointerCapture(e.pointerId);
    setFromX(e.clientX);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (dragging) setFromX(e.clientX);
  });
  const stop = (e: PointerEvent): void => {
    dragging = false;
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
  };
  wrap.addEventListener("pointerup", stop);
  wrap.addEventListener("pointercancel", stop);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") pos = Math.max(0, pos - 2);
    else if (e.key === "ArrowRight") pos = Math.min(100, pos + 2);
    else return;
    e.preventDefault();
    apply();
  });

  return wrap;
}

// ------------------------------------------------------------------- apply

function renderApply(): void {
  if (!snapshot) {
    applyBarEl.classList.add("hidden");
    return;
  }
  const pending = snapshot.comments.filter((c) => c.status !== "applied").length;
  applyBarEl.classList.toggle("hidden", pending === 0);
  if (pending === 0) disarm();
  const noun = pending === 1 ? "comment" : "comments";
  applyEl.disabled = applying;
  applyEl.classList.toggle("armed", armed && !applying);
  if (applying) {
    applySummaryEl.textContent = `Sending ${pending} ${noun} to the agent…`;
    applyEl.textContent = "Sending…";
  } else if (armed) {
    applySummaryEl.textContent = "This sends the comments to the agent — press again to confirm, Esc to cancel.";
    applyEl.textContent = `Confirm — send ${pending} ${noun}`;
  } else {
    applySummaryEl.textContent = `${pending} ${noun} ready to send back to the agent`;
    applyEl.textContent = `Apply ${pending} ${noun} →`;
  }
}

/** Arm the send on the first press; a second press within the window confirms.
 *  Sending is irreversible, so this is the guard against an accidental apply. */
function requestApply(): void {
  if (!sessionId || applying) return;
  if (!armed) {
    armed = true;
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = window.setTimeout(disarm, 4000);
    renderApply();
    return;
  }
  disarm();
  void applyComments();
}

function disarm(): void {
  if (armTimer !== null) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  if (!armed) return;
  armed = false;
  renderApply();
}

async function applyComments(): Promise<void> {
  if (!sessionId || applying) return;
  applying = true;
  statusEl.textContent = "";
  renderApply();
  try {
    const outcome = await invoke<ApplyOutcome>("apply_comments", { id: sessionId });
    // Applying clears the staged comments and returns to the workspace; a
    // blocked outcome (drifted comments) stays open so the failure is visible.
    if (outcome.outcome === "applied") {
      applying = false;
      // Confirm the send before teardown — a toast lives on <body>, so it
      // survives closeReview() and stays readable after the panel is gone.
      toast(describeOutcome(outcome));
      closeReview();
      return;
    }
    statusEl.textContent = describeOutcome(outcome);
  } catch (e) {
    statusEl.textContent = "Couldn't send the comments. Please try again.";
    toast("Couldn't send the comments to the agent.", "error", String(e));
  }
  applying = false;
  await refresh();
}

document.querySelector("#review-close")!.addEventListener("click", closeReview);
document.querySelector("#review-refresh")!.addEventListener("click", () => void refresh());
applyEl.addEventListener("click", requestApply);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || reviewEl.classList.contains("hidden")) return;
  // Unwind the most local state first: a primed Apply, then a line selection,
  // then the panel itself.
  if (armed) {
    disarm();
  } else if (selection) {
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
  } else if ((e.key === "Enter" || e.key === "c") && cursor !== null) {
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
