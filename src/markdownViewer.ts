// Markdown viewer: a distraction-free reader for the active session's repo
// docs (plans, design docs, READMEs), toggled with Cmd+M. A centered column
// renders the file with @tanstack/markdown; the bar above it is a search-style
// button that drops a fuzzy file picker over every *.md in the worktree, in
// relevance order (backed by `list_markdown_files` / `read_session_file` /
// `read_session_image` in src-tauri/src/files.rs). Which doc opens is the
// relevance ladder in ./markdownRelevance (ADR-0005): docs the session's branch
// changed, newest first → README → the picker, with the last-viewed doc winning
// unless the agent has touched something since. In-repo .md links open in
// the viewer; anchors scroll; everything else is inert. Repo-relative images
// are swapped to data: URIs (ADR-0006); code blocks are Shiki-highlighted in
// the active theme (ADR-0005) and re-render on theme switches. While the
// viewer is open the displayed file is re-read on a ~1.5s poll (ADR-0004) so
// a doc an agent is still writing stays live, scroll position intact.

import { invoke } from "@tauri-apps/api/core";
import { parseMarkdown } from "@tanstack/markdown/parser";
import { renderHtml } from "@tanstack/markdown/html";
import {
  rankByRelevance,
  resolveTarget,
  type LastViewed,
  type MdFile,
} from "./markdownRelevance";
import { ensureLang, ensureShikiTheme, getHighlighter, resolveLang } from "./shiki";
import { currentTheme, onThemeChange } from "./theme";
import { toast } from "./toast";

type OpenParams = {
  sessionId: string;
  focusTerminal: () => void;
  /** Optional file to open immediately (repo-relative). */
  initialPath?: string;
};

/** One entry from list_markdown_files, as the backend serializes it. */
type RawMdFile = { path: string; mtime: number; changed_on_branch: boolean };
type MdListing = { files: RawMdFile[]; total: number };

let sessionId: string | null = null;
let focusTerminal: () => void = () => {};
/** The listing in relevance order (ADR-0005) — also the picker's row order. */
let files: MdFile[] = [];
/** Total *.md count before the backend's cap; > files.length when truncated. */
let total = 0;
let current: string | null = null;
let currentSource: string | null = null;

// Where the viewer was last left, per session — so reopening returns to the doc
// you were reading. In-memory for the app's lifetime, deliberately not
// persisted (a doc that mattered last week rarely matters on a cold start).
const lastViewedBySession = new Map<string, LastViewed>();

// data: URIs (null = unusable → placeholder) per repo-relative image path,
// so a theme-switch re-render doesn't re-read every image. Cleared on open.
const imageCache = new Map<string, string | null>();

// --------------------------------------------------------------------- DOM

const root = document.createElement("div");
root.id = "mdv";
root.className = "hidden";

const panel = document.createElement("div");
panel.className = "mdv-panel";
panel.tabIndex = -1;
root.appendChild(panel);

const bar = document.createElement("div");
bar.className = "mdv-bar";
const nameBtn = document.createElement("button");
nameBtn.className = "mdv-name";
nameBtn.title = "Switch file (/)";
const nameIcon = document.createElement("span");
nameIcon.className = "mdv-name-icon";
nameIcon.textContent = "⌕";
const nameText = document.createElement("span");
nameText.className = "mdv-name-text";
const nameHint = document.createElement("kbd");
nameHint.className = "mdv-name-hint";
nameHint.textContent = "/";
nameBtn.appendChild(nameIcon);
nameBtn.appendChild(nameText);
nameBtn.appendChild(nameHint);
const closeBtn = document.createElement("button");
closeBtn.className = "mdv-close-btn";
closeBtn.textContent = "×";
closeBtn.title = "Close (Esc)";
bar.appendChild(nameBtn);
bar.appendChild(closeBtn);
panel.appendChild(bar);

const picker = document.createElement("div");
picker.className = "mdv-picker hidden";
const input = document.createElement("input");
input.className = "mdv-input";
input.placeholder = "Search markdown files…";
input.setAttribute("aria-label", "Search markdown files");
const list = document.createElement("div");
list.className = "mdv-list";
picker.appendChild(input);
picker.appendChild(list);
panel.appendChild(picker);

const doc = document.createElement("div");
doc.className = "mdv-doc";
panel.appendChild(doc);

document.body.appendChild(root);

// ------------------------------------------------------------------ public

export function isMarkdownViewerOpen(): boolean {
  return !root.classList.contains("hidden");
}

export async function openMarkdownViewer(params: OpenParams): Promise<void> {
  sessionId = params.sessionId;
  focusTerminal = params.focusTerminal;
  root.classList.remove("hidden");
  imageCache.clear();
  try {
    const listing = await invoke<MdListing>("list_markdown_files", { sessionId });
    files = rankByRelevance(listing.files.map(toMdFile));
    total = listing.total;
  } catch (e) {
    toast(`could not list markdown files: ${e}`, "error");
    files = [];
    total = 0;
  }
  const initial =
    params.initialPath && files.some((f) => f.path === params.initialPath)
      ? params.initialPath
      : resolveTarget(files, lastViewedBySession.get(params.sessionId) ?? null);
  panel.focus();
  if (initial) {
    void showFile(initial);
  } else if (files.length) {
    // Nothing obvious to show — lead with the picker so the affordance is
    // impossible to miss.
    nameText.textContent = "choose a file…";
    doc.innerHTML = "";
    openPicker();
  } else {
    nameText.textContent = "no markdown files";
    doc.innerHTML = `<div class="mdv-empty">No markdown files in this repo.</div>`;
  }
  startPolling();
}

export function closeMarkdownViewer(): void {
  stopPolling();
  sessionId = null;
  current = null;
  currentSource = null;
  imageCache.clear();
  closePicker();
  root.classList.add("hidden");
  focusTerminal();
}

// ------------------------------------------------------------- live reload

// Re-read the displayed file while the viewer is open (ADR-0004). Runs only
// while the window is visible; a failed read keeps the last good rendering.
const POLL_MS = 1500;
let pollTimer: number | null = null;
let pollInFlight = false;

function startPolling(): void {
  if (pollTimer !== null || document.visibilityState === "hidden") return;
  pollTimer = window.setInterval(() => void pollCurrent(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function pollCurrent(): Promise<void> {
  const sid = sessionId;
  const path = current;
  if (!sid || !path || pollInFlight) return;
  pollInFlight = true;
  try {
    const source = await invoke<string>("read_session_file", { sessionId: sid, relPath: path });
    if (sessionId !== sid || current !== path || !isMarkdownViewerOpen()) return;
    if (source === currentSource) return; // unchanged — don't touch the DOM
    currentSource = source;
    renderDocPreservingScroll(path, source);
    markViewed(path);
  } catch {
    // mid-write read failure — the last good rendering stays
  } finally {
    pollInFlight = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") stopPolling();
  else if (isMarkdownViewerOpen()) startPolling();
});

// --------------------------------------------------------------- rendering

async function showFile(path: string): Promise<void> {
  current = path;
  closePicker();
  nameText.textContent = path;
  doc.innerHTML = `<div class="mdv-empty">Reading ${path}…</div>`;
  if (!sessionId) return;
  let source: string;
  try {
    source = await invoke<string>("read_session_file", { sessionId, relPath: path });
  } catch (e) {
    if (current !== path) return;
    currentSource = null; // the poll re-renders once the file is readable
    doc.innerHTML = "";
    toast(`could not read ${path}: ${e}`, "error");
    return;
  }
  if (current !== path) return; // switched while reading
  currentSource = source;
  renderDoc(path, source);
  doc.scrollTop = 0;
  panel.focus();
  markViewed(path);
}

/** Note that `path` has been seen *now*, so a later reopen returns here — and
 *  only a doc the agent changes after this point outranks it. Live reload comes
 *  through here too: what you've just watched re-render counts as seen. */
function markViewed(path: string): void {
  if (sessionId) lastViewedBySession.set(sessionId, { path, at: Date.now() / 1000 });
}

/** Backend listing entry → the shape the pure relevance functions take. */
function toMdFile(f: RawMdFile): MdFile {
  return { path: f.path, mtime: f.mtime, changedOnBranch: f.changed_on_branch };
}

/** Render `source` into the doc column and kick off the async decorations
 *  (relative images, Shiki). Synchronous DOM swap so callers can manage
 *  scroll position around it. */
function renderDoc(path: string, source: string): void {
  doc.innerHTML = renderHtml(parseMarkdown(source, { frontmatter: true }));
  doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        doc.querySelector(href)?.scrollIntoView({ block: "start" });
        return;
      }
      const target = resolveRelative(path, href);
      // A truncated listing can't vouch for every in-repo doc, so past the cap
      // any resolvable .md is worth attempting (showFile toasts if unreadable).
      if (target && (files.some((f) => f.path === target) || files.length < total)) {
        void showFile(target);
      } else {
        toast("only in-repo .md links open here");
      }
    });
  });
  void hydrateImages(path);
  void highlightCode(path);
}

/** Re-render without the reader losing their place — the live-reload and
 *  theme-switch paths both come through here. */
function renderDocPreservingScroll(path: string, source: string): void {
  const top = doc.scrollTop;
  renderDoc(path, source);
  doc.scrollTop = top;
}

// Re-render the current document when the theme switches so Shiki blocks pick
// up the new theme; images come from the cache, and the scroll position holds.
onThemeChange(() => {
  if (!isMarkdownViewerOpen() || current === null || currentSource === null) return;
  renderDocPreservingScroll(current, currentSource);
});

/** True when `s` starts with a URL scheme (http:, https:, data:, mailto:…). */
function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/** Resolve `href` against the directory of `from`; null if not an in-repo .md. */
function resolveRelative(from: string, href: string): string | null {
  if (hasScheme(href)) return null;
  const clean = href.split("#")[0];
  if (!clean.toLowerCase().endsWith(".md")) return null;
  return joinRepoPath(from, clean);
}

/** Join a repo-relative `rel` onto the directory of `from`, normalizing
 *  `.`/`..` segments. Purely lexical; the backend re-guards against escapes. */
function joinRepoPath(from: string, rel: string): string {
  const base = from.split("/").slice(0, -1);
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

// ------------------------------------------------------------------- images

/** MIME by extension for repo-relative images; anything else gets a
 *  placeholder rather than a fetch (ADR-0006). */
const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** Swap repo-relative <img> tags to data: URIs via read_session_image.
 *  Remote http(s) images are left untouched (they load natively). A missing,
 *  oversized, or non-whitelisted image becomes a quiet placeholder — never a
 *  broken document. */
async function hydrateImages(docPath: string): Promise<void> {
  const sid = sessionId;
  if (!sid) return;
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img"));
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    if (hasScheme(src)) continue; // http(s)/data: — untouched
    const relPath = joinRepoPath(docPath, src);
    const mime = IMG_MIME[relPath.split(".").pop()?.toLowerCase() ?? ""];
    let dataUri = imageCache.get(relPath);
    if (dataUri === undefined) {
      if (!mime) {
        dataUri = null;
      } else {
        try {
          const b64 = await invoke<string>("read_session_image", { sessionId: sid, relPath });
          dataUri = `data:${mime};base64,${b64}`;
        } catch {
          dataUri = null; // missing / oversized / unreadable
        }
      }
      imageCache.set(relPath, dataUri);
    }
    if (current !== docPath) return; // switched while reading
    if (dataUri !== null) {
      img.src = dataUri;
    } else if (img.isConnected) {
      const ph = document.createElement("span");
      ph.className = "mdv-img-missing";
      ph.title = "image unavailable";
      ph.textContent = `⊘ ${src}`;
      img.replaceWith(ph);
    }
  }
}

// -------------------------------------------------------------- code blocks

/** Shiki-highlight fenced code blocks in place, matching the review view's
 *  theme (ADR-0005). Unknown languages and highlighter failures leave the
 *  plain <pre> untouched. */
async function highlightCode(docPath: string): Promise<void> {
  const blocks = Array.from(doc.querySelectorAll<HTMLElement>("pre > code[class*='language-']"));
  for (const code of blocks) {
    const info = /language-(\S+)/.exec(code.className)?.[1] ?? "";
    const lang = resolveLang(info);
    if (!lang) continue;
    try {
      const hl = await getHighlighter();
      await ensureLang(hl, lang);
      const themeName = await ensureShikiTheme(hl, currentTheme());
      if (current !== docPath || !code.isConnected) return;
      const tpl = document.createElement("template");
      tpl.innerHTML = hl.codeToHtml(code.textContent ?? "", { lang, theme: themeName });
      const highlighted = tpl.content.firstElementChild;
      if (highlighted) code.parentElement?.replaceWith(highlighted);
    } catch {
      // plain block stays
    }
  }
}

// ------------------------------------------------------------------ picker

let cursor = 0;

function isPickerOpen(): boolean {
  return !picker.classList.contains("hidden");
}

function openPicker(): void {
  picker.classList.remove("hidden");
  input.value = "";
  cursor = 0;
  renderList();
  input.focus();
  // Re-list in the background so files created since the viewer opened
  // surface (the viewer never navigates on its own — they only appear here).
  void refreshListing();
}

async function refreshListing(): Promise<void> {
  const sid = sessionId;
  if (!sid) return;
  let listing: MdListing;
  try {
    listing = await invoke<MdListing>("list_markdown_files", { sessionId: sid });
  } catch {
    return; // stale listing stays — same stance as a failed poll read
  }
  if (sessionId !== sid || !isPickerOpen()) return;
  files = rankByRelevance(listing.files.map(toMdFile));
  total = listing.total;
  renderList();
}

function closePicker(): void {
  picker.classList.add("hidden");
}

/** Subsequence match, same spirit as the command palette. Preserves the
 *  listing's relevance order, so it breaks ties while typing. */
function matches(): string[] {
  const q = input.value.toLowerCase();
  return files
    .map((f) => f.path)
    .filter((p) => {
      let i = 0;
      for (const c of p.toLowerCase()) if (c === q[i]) i++;
      return i === q.length;
    });
}

function renderList(): void {
  const m = matches();
  if (cursor >= m.length) cursor = Math.max(0, m.length - 1);
  list.innerHTML = "";
  if (!m.length) {
    const empty = document.createElement("div");
    empty.className = "mdv-empty";
    empty.textContent = "No matching files.";
    list.appendChild(empty);
    return;
  }
  m.slice(0, 12).forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "mdv-row" + (i === cursor ? " cursor" : "");
    row.textContent = f;
    row.addEventListener("click", () => void showFile(f));
    list.appendChild(row);
  });
  if (total > files.length) {
    // The backend capped the listing (relevance-ordered, so only the stalest
    // untouched files were dropped): say so rather than silently pretending
    // this is everything.
    const cap = document.createElement("div");
    cap.className = "mdv-cap-row";
    cap.textContent = `${files.length} of ${total} — keep typing to narrow`;
    list.appendChild(cap);
  }
}

nameBtn.addEventListener("click", () => (isPickerOpen() ? closePicker() : openPicker()));
closeBtn.addEventListener("click", closeMarkdownViewer);

input.addEventListener("input", () => {
  cursor = 0;
  renderList();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") cursor++;
  else if (e.key === "ArrowUp") cursor = Math.max(0, cursor - 1);
  else if (e.key === "Enter") {
    const m = matches();
    if (m[cursor]) void showFile(m[cursor]);
    e.preventDefault();
    e.stopPropagation();
    return;
  } else if (e.key === "Escape") {
    // First Esc closes the picker (back to the doc); if nothing is shown yet
    // the viewer itself closes via the window handler below.
    if (current) {
      closePicker();
      panel.focus();
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  } else return;
  e.preventDefault();
  renderList();
});

window.addEventListener(
  "keydown",
  (e) => {
    if (!isMarkdownViewerOpen()) return;
    const t = e.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
    if (e.key === "Escape" && !typing) {
      e.preventDefault();
      e.stopPropagation();
      closeMarkdownViewer();
    } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      openPicker();
    }
  },
  true,
);
