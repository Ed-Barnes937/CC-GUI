import { invoke } from "@tauri-apps/api/core";
import { score } from "./palette";
import { toast } from "./toast";

// A lightweight, keyboard-driven file browser scoped to a session's repo.
// Two modes over the same list: browse one directory at a time, or start
// typing to fuzzy-search every path in the repo at once. Opening a file drops
// an `@path` reference into the active terminal for the running Claude session.
// Styled after nnn: single column, keyboard-first, mouse-supported.
//
// Typing always searches, so plain letters are not shortcuts here (`.`
// included — hidden files toggle on Ctrl/Cmd+`.`). Navigation is on the keys
// that can't be typed into a query: arrows, Enter, Backspace, Esc.

type FsEntry = { name: string; is_dir: boolean; size: number };
type DirListing = { rel_path: string; at_root: boolean; entries: FsEntry[] };
type TreeEntry = { path: string; is_dir: boolean; size: number };
type TreeListing = { entries: TreeEntry[]; total: number };

/** One rendered line, in either mode. `path` is repo-root-relative. */
type Row = { path: string; name: string; is_dir: boolean; size: number };

type OpenParams = {
  sessionId: string;
  tmuxSession: string;
  rootLabel: string;
  focusTerminal: () => void;
};

/** Cap on rendered search hits — past this the ranking is noise anyway. */
const SEARCH_MAX_ROWS = 200;

const el = document.querySelector<HTMLDivElement>("#file-explorer")!;
const crumbsEl = document.querySelector<HTMLSpanElement>("#fx-crumbs")!;
const listEl = document.querySelector<HTMLDivElement>("#fx-list")!;
const hiddenHintEl = document.querySelector<HTMLSpanElement>("#fx-hidden-hint")!;
const hintEl = document.querySelector<HTMLSpanElement>("#fx-hint")!;
const filterEl = document.querySelector<HTMLSpanElement>("#fx-filter")!;
const countEl = document.querySelector<HTMLSpanElement>("#fx-count")!;

let sessionId: string | null = null;
let tmuxSession = "";
let rootLabel = "";
let focusTerminal: () => void = () => {};
let subPath = ""; // relative to the repo root; "" at the root
let entries: FsEntry[] = [];
let cursor = 0;
let query = ""; // non-empty = repo-wide search mode
let showHidden = false;
let loading = false;
let loadError: string | null = null;

// The repo-wide listing behind search mode. Fetched on the first keystroke and
// kept until the session closes or the hidden-files toggle changes what's in it.
let tree: TreeEntry[] | null = null;
let treeTotal = 0;
let treeLoading = false;
let treeError: string | null = null;

export function isExplorerOpen(): boolean {
  return !el.classList.contains("hidden");
}

export async function openExplorer(params: OpenParams): Promise<void> {
  sessionId = params.sessionId;
  tmuxSession = params.tmuxSession;
  rootLabel = params.rootLabel;
  focusTerminal = params.focusTerminal;
  subPath = "";
  cursor = 0;
  clearQuery();
  showHidden = false;
  el.classList.remove("hidden");
  await load();
  listEl.focus();
}

export function closeExplorer(): void {
  sessionId = null;
  clearQuery();
  el.classList.add("hidden");
}

function searching(): boolean {
  return query.length > 0;
}

/** Drop the query and the repo listing it was searching. */
function clearQuery(): void {
  query = "";
  tree = null;
  treeTotal = 0;
  treeLoading = false;
  treeError = null;
}

/** The rows to render: the current directory, or the repo-wide search hits. */
function visible(): Row[] {
  if (!searching()) {
    return entries.map((e) => ({
      path: subPath ? `${subPath}/${e.name}` : e.name,
      name: e.name,
      is_dir: e.is_dir,
      size: e.size,
    }));
  }
  if (!tree) return [];
  const hits: { row: Row; s: number }[] = [];
  for (const e of tree) {
    const row: Row = { ...e, name: e.path.slice(e.path.lastIndexOf("/") + 1) };
    const s = rank(query, row);
    if (s !== null) hits.push({ row, s });
  }
  hits.sort(
    (a, b) =>
      b.s - a.s || a.row.path.length - b.row.path.length || (a.row.path < b.row.path ? -1 : 1),
  );
  return hits.slice(0, SEARCH_MAX_ROWS).map((h) => h.row);
}

/**
 * Fuzzy score for one path, reusing the palette's subsequence scorer. A hit on
 * the file name is what the user usually means, so it outranks one that only
 * lands by picking letters out of the directories above it.
 */
function rank(q: string, row: Row): number | null {
  const byName = score(q, row.name);
  const byPath = score(q, row.path);
  if (byName === null && byPath === null) return null;
  return Math.max(byName === null ? -Infinity : byName + 100, byPath ?? -Infinity);
}

async function load(): Promise<void> {
  if (!sessionId) return;
  const id = sessionId;
  loadError = null;
  loading = true;
  render();
  try {
    const listing = await invoke<DirListing>("list_session_dir", {
      sessionId: id,
      subPath,
      showHidden,
    });
    if (sessionId !== id) return; // closed or switched while loading
    entries = listing.entries;
    subPath = listing.rel_path;
  } catch (e) {
    if (sessionId !== id) return; // closed or switched while loading
    entries = [];
    loadError = String(e);
  }
  loading = false;
  cursor = 0;
  render();
}

/** Fetch the repo-wide listing that search mode ranks over. */
async function loadTree(): Promise<void> {
  if (!sessionId || treeLoading || tree) return;
  const id = sessionId;
  const hidden = showHidden;
  treeLoading = true;
  treeError = null;
  render();
  try {
    const listing = await invoke<TreeListing>("list_session_tree", {
      sessionId: id,
      showHidden: hidden,
    });
    // Bail if the session closed, or the toggle moved, while we were loading.
    if (sessionId !== id || showHidden !== hidden) return;
    tree = listing.entries;
    treeTotal = listing.total;
  } catch (e) {
    if (sessionId !== id || showHidden !== hidden) return;
    tree = [];
    treeError = String(e);
  } finally {
    if (sessionId === id) {
      treeLoading = false;
      render();
    }
  }
}

function render(): void {
  renderCrumbs();
  const list = visible();
  if (cursor >= list.length) cursor = Math.max(0, list.length - 1);

  listEl.innerHTML = "";
  const error = searching() ? treeError : loadError;
  if (error) {
    const err = document.createElement("div");
    err.className = "fx-empty fx-error";
    err.textContent = searching()
      ? `Couldn't search this repo — ${error}`
      : `Couldn't read this folder — ${error}`;
    listEl.appendChild(err);
  } else if ((searching() ? treeLoading : loading) && !list.length) {
    const busy = document.createElement("div");
    busy.className = "fx-empty";
    busy.textContent = searching() ? "Reading the repo…" : "Reading folder…";
    listEl.appendChild(busy);
  } else if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "fx-empty";
    empty.textContent = searching() ? "No matches." : "Empty directory.";
    listEl.appendChild(empty);
  }
  list.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "fx-row" + (entry.is_dir ? " dir" : "") + (i === cursor ? " cursor" : "");
    row.id = `fx-row-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === cursor));
    // Search hits come from anywhere in the repo, so they lead with the
    // directories above them; browsing already has that in the breadcrumb.
    const parent = searching() ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
    if (parent) {
      const dir = document.createElement("span");
      dir.className = "fx-parent";
      dir.textContent = parent;
      row.appendChild(dir);
    }
    const name = document.createElement("span");
    name.className = "fx-name";
    name.textContent = entry.is_dir ? `${entry.name}/` : entry.name;
    row.appendChild(name);
    if (!entry.is_dir) {
      const size = document.createElement("span");
      size.className = "fx-size";
      size.textContent = fmtSize(entry.size);
      row.appendChild(size);
    }
    row.addEventListener("click", () => {
      cursor = i;
      render();
    });
    row.addEventListener("dblclick", () => {
      cursor = i;
      openEntry();
    });
    listEl.appendChild(row);
  });

  const cursorRow = listEl.querySelector<HTMLElement>(".fx-row.cursor");
  cursorRow?.scrollIntoView({ block: "nearest" });
  if (cursorRow) listEl.setAttribute("aria-activedescendant", cursorRow.id);
  else listEl.removeAttribute("aria-activedescendant");

  hiddenHintEl.textContent = showHidden ? "· hidden shown" : "";
  hintEl.textContent = statusHint();
  filterEl.textContent = `⌕ ${query}`;
  filterEl.classList.toggle("hidden", !searching());
  countEl.textContent = list.length ? `${cursor + 1}/${list.length}` : "0";
}

function statusHint(): string {
  if (!searching()) {
    return "↵ open folder · @path a file · type to search the repo · ⌃. hidden";
  }
  // Say so when the walk hit its cap, so a missing file reads as truncation
  // rather than as the search being wrong.
  const capped = tree && treeTotal > tree.length ? ` · first ${tree.length} paths only` : "";
  return `↵ open · ⌫ delete · esc clear${capped}`;
}

function renderCrumbs(): void {
  crumbsEl.innerHTML = "";
  const parts = subPath ? subPath.split("/") : [];
  const addCrumb = (label: string, depth: number, leaf: boolean) => {
    const span = document.createElement("span");
    span.className = "fx-crumb" + (leaf ? " leaf" : "");
    span.textContent = label;
    if (!leaf) span.addEventListener("click", () => jumpTo(depth));
    crumbsEl.appendChild(span);
  };
  addCrumb(rootLabel, 0, parts.length === 0);
  parts.forEach((part, i) => {
    const sep = document.createElement("span");
    sep.className = "fx-sep";
    sep.textContent = "▸";
    crumbsEl.appendChild(sep);
    addCrumb(part, i + 1, i === parts.length - 1);
  });
}

/** Navigate to a breadcrumb depth (0 = root). */
function jumpTo(depth: number): void {
  const parts = subPath ? subPath.split("/") : [];
  subPath = parts.slice(0, depth).join("/");
  clearQuery();
  void load();
}

function goUp(): void {
  if (!subPath) return;
  const parts = subPath.split("/");
  parts.pop();
  subPath = parts.join("/");
  clearQuery();
  void load();
}

/** Open the entry under the cursor: descend into a dir, or reference a file. */
function openEntry(): void {
  const entry = visible()[cursor];
  if (!entry) return;
  if (entry.is_dir) {
    subPath = entry.path;
    clearQuery();
    void load();
    return;
  }
  void invoke("write_pty", { tmuxSession, data: `@${entry.path} ` }).catch((e) =>
    toast(`could not insert reference: ${e}`, "error"),
  );
  closeExplorer();
  focusTerminal();
}

function move(delta: number): void {
  const list = visible();
  if (!list.length) return;
  cursor = Math.min(list.length - 1, Math.max(0, cursor + delta));
  render();
}

/** Append to the query, entering search mode and fetching the repo listing. */
function typeIntoQuery(ch: string): void {
  query += ch;
  cursor = 0;
  if (!tree && !treeLoading) void loadTree();
  else render();
}

listEl.addEventListener("keydown", (e) => {
  if (!isExplorerOpen()) return;
  const key = e.key;
  const mod = e.metaKey || e.ctrlKey || e.altKey;

  // Ctrl/Cmd+. toggles hidden entries — a modifier, because a bare `.` is a
  // character a query may need.
  if (key === "." && (e.metaKey || e.ctrlKey) && !e.altKey) {
    showHidden = !showHidden;
    tree = null; // the repo listing depends on the toggle
    treeTotal = 0;
    if (searching()) void loadTree();
    void load();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  switch (key) {
    case "ArrowDown":
      move(1);
      break;
    case "ArrowUp":
      move(-1);
      break;
    case "Enter":
    case "ArrowRight":
      openEntry();
      break;
    case "Backspace":
      if (searching()) {
        query = query.slice(0, -1);
        if (!query) clearQuery();
        cursor = 0;
        render();
      } else {
        goUp();
      }
      break;
    case "ArrowLeft":
      if (!searching()) goUp();
      break;
    case "Home":
      cursor = 0;
      render();
      break;
    case "End":
      cursor = Math.max(0, visible().length - 1);
      render();
      break;
    case "Escape":
      if (searching()) {
        clearQuery();
        cursor = 0;
        render();
      } else {
        closeExplorer();
        focusTerminal();
      }
      break;
    default:
      if (key.length === 1 && !mod) typeIntoQuery(key);
      else return; // don't swallow keys we don't handle
  }
  e.preventDefault();
  e.stopPropagation();
});

document.querySelector<HTMLButtonElement>("#fx-close")!.addEventListener("click", () => {
  closeExplorer();
  focusTerminal();
});

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / 1024 / 1024).toFixed(1)} M`;
}
