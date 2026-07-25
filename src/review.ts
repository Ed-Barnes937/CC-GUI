import { invoke } from "@tauri-apps/api/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput,
} from "shiki/core";
import { noTextAssist } from "./dom";
import { makeResizable } from "./resize";
import { toast } from "./toast";
import { currentTheme, onThemeChange, type Theme } from "./theme";
import {
  buildDraft,
  commentsByAnchor,
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

// ------------------------------------------------------- syntax highlighting

type ThemedToken = { content: string; color?: string };

const EXT_LANG: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
};

// Fine-grained Shiki loaders: we bundle only the languages EXT_LANG can name and
// the theme ids the built-in registry uses. Importing the full "shiki" bundle
// instead emits a lazy chunk for every one of Shiki's ~270 langs and ~60 themes
// (almost all unused). Each lang module inlines its embedded grammars (e.g. vue →
// html/css/ts), so loading one is self-contained.
const LANG_LOADERS: Record<string, LanguageInput> = {
  rust: () => import("@shikijs/langs/rust"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  ruby: () => import("@shikijs/langs/ruby"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  markdown: () => import("@shikijs/langs/markdown"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
};

const THEME_LOADERS: Record<string, ThemeInput> = {
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
  "catppuccin-latte": () => import("@shikijs/themes/catppuccin-latte"),
  "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
  "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
  "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  dracula: () => import("@shikijs/themes/dracula"),
  nord: () => import("@shikijs/themes/nord"),
  "github-light": () => import("@shikijs/themes/github-light"),
  "solarized-light": () => import("@shikijs/themes/solarized-light"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter() {
  // Languages and themes load on demand (loadLanguage / ensureShikiTheme) rather
  // than up front: built-ins are bundled ids, custom themes supply a full TextMate
  // object at runtime, so the set isn't known when the highlighter is created.
  highlighterPromise ??= createHighlighterCore({
    themes: [],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighterPromise;
}

// Shiki language ids already registered in the highlighter, so we never double-load.
const loadedLangs = new Set<string>();

// Shiki theme names already registered in the highlighter, so we never double-load.
const loadedThemes = new Set<string>();

/**
 * Ensure the given theme's Shiki theme is loaded, and return the name to pass to
 * codeToTokens. A built-in's `shiki` is a bundled id (loaded by string); a custom
 * theme's is a full TextMate object whose `name` validateTheme forced to the theme
 * id. Keyed by that name so repeated renders reuse the already-loaded theme.
 */
async function ensureShikiTheme(hl: HighlighterCore, theme: Theme): Promise<string> {
  const shiki = theme.shiki;
  const name = typeof shiki === "string" ? shiki : (shiki.name ?? theme.id);
  if (!loadedThemes.has(name)) {
    // A built-in id loads via its bundled loader; a custom theme's TextMate object
    // is passed straight through.
    await hl.loadTheme(typeof shiki === "string" ? THEME_LOADERS[shiki] : shiki);
    loadedThemes.add(name);
  }
  return name;
}

/** Per-file token cache: hunk index → line index → tokens. Reset on refresh. */
const tokenCache = new Map<string, ThemedToken[][][] | null>();

/** Image data-URL cache, keyed by `${path}\0${side}`. Reset on refresh so a new
 *  snapshot re-reads the bytes; avoids re-fetching on theme change / re-render. */
const imageCache = new Map<string, string>();

/**
 * Tokenize a file's hunks with shiki (language from the extension). Each hunk
 * is highlighted as one block so multi-line constructs mostly survive; the
 * missing cross-hunk context is an accepted approximation. Returns null when
 * the language is unknown or shiki fails — callers fall back to plain text.
 */
async function prepareHighlights(file: FileDiff): Promise<void> {
  const path = displayPath(file);
  if (tokenCache.has(path)) return;
  const ext = path.split(".").pop() ?? "";
  const lang = EXT_LANG[ext];
  if (!lang) {
    tokenCache.set(path, null);
    return;
  }
  try {
    const hl = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      await hl.loadLanguage(LANG_LOADERS[lang]);
      loadedLangs.add(lang);
    }
    const themeName = await ensureShikiTheme(hl, currentTheme());
    const hunks = file.hunks.map((hunk) => {
      const code = hunk.lines.map((l) => l.content).join("\n");
      const result = hl.codeToTokens(code, { lang, theme: themeName });
      const tokens = result.tokens as ThemedToken[][];
      // Token rows must map 1:1 onto hunk lines; on any drift (e.g. line-
      // ending normalization) fall back to plain text rather than misalign.
      return tokens.length === hunk.lines.length ? tokens : [];
    });
    tokenCache.set(path, hunks);
  } catch {
    tokenCache.set(path, null);
  }
}

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

// Line selection for a new comment: inclusive index range into the rendered
// (selectable) lines of the current file, in click order.
let selection: { anchor: number; head: number } | null = null;
let draftText = ""; // survives re-renders while extending the selection
let applying = false;

// Keyboard cursor: index into the current file's flat lines. Drives the
// focus ring and the Enter/`c` "comment here" shortcut, so the diff is
// reviewable without a mouse. Null until the first j/k or line click.
let cursor: number | null = null;

// Apply is irreversible (it hands the comments to the agent), so the button
// arms on the first press and only sends on the second. Auto-disarms after a
// short window so a stray click never leaves it primed.
let armed = false;
let armTimer: number | null = null;

// The element focused before the review opened, so closing returns focus there
// instead of dropping it to <body>.
let restoreFocus: HTMLElement | null = null;

export async function openReview(id: string, title: string): Promise<void> {
  sessionId = id;
  restoreFocus = document.activeElement as HTMLElement | null;
  titleEl.textContent = title;
  baseEl.textContent = "";
  statusEl.textContent = "";
  clearSelection();
  disarm();
  filesEl.innerHTML = "";
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
  tokenCache.clear();
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
  highlightCurrentFile();
}

/** Tokenize the selected file in the background, then re-render with color. */
function highlightCurrentFile(): void {
  const file = currentFile();
  if (!file || tokenCache.has(displayPath(file))) return;
  const path = displayPath(file);
  void prepareHighlights(file).then(() => {
    // Still looking at the same file once tokens are ready?
    if (selectedFile === path && tokenCache.get(path)) renderDiff();
  });
}

// Re-highlight on theme change. Token colors are baked into the rendered spans
// (span.style.color), so clearing the cache is not enough — we must re-tokenize
// the open file with the new theme and rebuild the DOM. Mirrors refresh()'s
// render-then-highlight sequence.
onThemeChange(() => {
  if (!sessionId) return; // review not open
  tokenCache.clear();
  renderDiff();
  highlightCurrentFile();
});

export function closeReview(): void {
  sessionId = null;
  snapshot = null;
  clearSelection();
  disarm();
  reviewEl.classList.add("hidden");
  // Return focus to whatever opened the review (a session row action).
  restoreFocus?.focus?.();
  restoreFocus = null;
}

function clearSelection(): void {
  selection = null;
  draftText = "";
  cursor = null;
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
  highlightCurrentFile();
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
      highlightCurrentFile();
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

/** Append a trailing section to the diff for comments that don't anchor to any
 *  rendered line — their anchor line, or whole file, has left the diff. Keeps
 *  them visible and deletable instead of silently dropping them. Mirrors
 *  claude-commander's TUI orphan handling. */
function renderOrphanComments(orphans: Comment[]): void {
  if (!orphans.length) return;
  const header = document.createElement("div");
  header.className = "hunk-header orphan-header";
  header.textContent = "Unanchored comments — lines no longer in the diff";
  diffEl.appendChild(header);
  for (const c of orphans) diffEl.appendChild(renderCommentBlock(c));
}

function renderDiff(): void {
  diffEl.innerHTML = "";
  if (!snapshot) return;
  const file = currentFile();
  if (!file) {
    // The selected path has no diff (its change was reverted) but may still
    // carry comments; render them so they stay visible and deletable.
    const stranded = selectedFile ? commentsForFile(selectedFile) : [];
    if (stranded.length) {
      renderOrphanComments(stranded);
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
    void renderImageDiff(file, mime);
    return;
  }
  const anchors = commentsByAnchor(snapshot.comments, displayPath(file));
  // Ids of comments rendered inline against a present line; the rest are
  // orphaned (their anchor line left the diff) and pinned in a trailing section.
  const rendered = new Set<string>();

  const selStart = selection ? Math.min(selection.anchor, selection.head) : -1;
  const selEnd = selection ? Math.max(selection.anchor, selection.head) : -1;
  const flatLines: DiffLine[] = file.hunks.flatMap((h) => h.lines);
  const fileTokens = tokenCache.get(displayPath(file)) ?? null;
  let idx = 0;
  let editorAnchorRow: HTMLDivElement | null = null;

  for (const [hunkIdx, hunk] of file.hunks.entries()) {
    const header = document.createElement("div");
    header.className = "hunk-header";
    header.textContent =
      `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@` +
      (hunk.header ? ` ${hunk.header}` : "");
    diffEl.appendChild(header);

    for (const [lineInHunk, line] of hunk.lines.entries()) {
      const lineIdx = idx++;
      const row = document.createElement("div");
      row.className = `diff-line diff-${line.origin}`;
      row.classList.toggle("selected", lineIdx >= selStart && lineIdx <= selEnd);
      // Each line is an actionable target: focus lands the keyboard cursor here
      // (roving tabindex — only the cursor line is tabbable) and Enter/`c`
      // opens a comment for it.
      row.setAttribute("role", "button");
      const lineNo = line.new_lineno ?? line.old_lineno;
      row.setAttribute(
        "aria-label",
        `Line ${lineNo ?? lineIdx + 1} — press Enter or C to comment`,
      );
      const isCursor = lineIdx === cursor;
      row.tabIndex = isCursor ? 0 : -1;
      row.classList.toggle("cursor", isCursor);

      const oldNo = document.createElement("span");
      oldNo.className = "lineno";
      oldNo.textContent = line.old_lineno?.toString() ?? "";
      const newNo = document.createElement("span");
      newNo.className = "lineno";
      newNo.textContent = line.new_lineno?.toString() ?? "";

      const marker = { context: " ", addition: "+", deletion: "-" }[line.origin];
      const content = document.createElement("span");
      content.className = "line-content";
      const tokens = fileTokens?.[hunkIdx]?.[lineInHunk];
      if (tokens) {
        // Syntax colors on token spans; the add/delete signal stays on the
        // row background (plain diff colors remain the un-highlighted
        // fallback via CSS).
        content.textContent = marker;
        for (const t of tokens) {
          const span = document.createElement("span");
          span.textContent = t.content;
          if (t.color) span.style.color = t.color;
          content.appendChild(span);
        }
      } else {
        content.textContent = `${marker}${line.content}`;
      }

      row.append(oldNo, newNo, content);
      row.addEventListener("click", (e) => {
        if (e.shiftKey && selection) {
          selection.head = lineIdx;
        } else if (selection?.anchor === lineIdx && selection.head === lineIdx) {
          clearSelection(); // click the sole selected line again to deselect
        } else {
          selection = { anchor: lineIdx, head: lineIdx };
        }
        cursor = lineIdx; // keep the keyboard cursor in step with the mouse
        renderDiff();
      });
      diffEl.appendChild(row);
      if (lineIdx === selEnd) editorAnchorRow = row;

      // Comments anchor to the end of their range on their side. Old/new line
      // numbers are unique within a file, so each comment matches one line.
      const lineComments = [
        ...(line.new_lineno ? (anchors.get(`new:${line.new_lineno}`) ?? []) : []),
        ...(line.old_lineno ? (anchors.get(`old:${line.old_lineno}`) ?? []) : []),
      ];
      for (const c of lineComments) {
        rendered.add(c.id);
        diffEl.appendChild(renderCommentBlock(c));
      }
    }
  }

  // Comments whose anchor line is no longer present in any hunk (the file
  // changed under them) match no rendered line, so they'd silently vanish —
  // and with them their delete button, stranding a drifted comment that blocks
  // apply with no way to clear it.
  renderOrphanComments(commentsForFile(displayPath(file)).filter((c) => !rendered.has(c.id)));

  if (selection && editorAnchorRow) {
    const selLines = flatLines.slice(selStart, selEnd + 1);
    editorAnchorRow.after(renderCommentEditor(selLines));
  }
}

/** Move the keyboard line cursor by `delta` within the current file (clamped,
 *  no wrap), re-render so the ring follows, and keep the cursor row focused and
 *  in view. Initialises to the first/last line when no cursor is set yet. */
function moveCursor(delta: number): void {
  const file = currentFile();
  if (!file) return;
  const count = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (!count) return;
  const from = cursor ?? (delta > 0 ? -1 : count);
  cursor = Math.min(count - 1, Math.max(0, from + delta));
  renderDiff();
  const row = diffEl.querySelector<HTMLElement>(".diff-line.cursor");
  row?.focus();
  row?.scrollIntoView({ block: "nearest" });
}

/** Open the comment composer for the current cursor line (the keyboard twin of
 *  clicking a line). No-op when the cursor is unset. */
function openComposerAtCursor(): void {
  if (cursor === null) return;
  selection = { anchor: cursor, head: cursor };
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
