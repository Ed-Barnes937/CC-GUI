import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";

// A lightweight, keyboard-driven file browser scoped to a session's repo.
// Drill down one directory at a time; opening a file drops an `@path`
// reference into the active terminal for the running Claude session.
// Styled after nnn: single column, keyboard-first, mouse-supported.

type FsEntry = { name: string; is_dir: boolean; size: number };
type DirListing = { rel_path: string; at_root: boolean; entries: FsEntry[] };

type OpenParams = {
  sessionId: string;
  tmuxSession: string;
  rootLabel: string;
  focusTerminal: () => void;
};

const el = document.querySelector<HTMLDivElement>("#file-explorer")!;
const crumbsEl = document.querySelector<HTMLSpanElement>("#fx-crumbs")!;
const listEl = document.querySelector<HTMLDivElement>("#fx-list")!;
const hiddenHintEl = document.querySelector<HTMLSpanElement>("#fx-hidden-hint")!;
const filterEl = document.querySelector<HTMLSpanElement>("#fx-filter")!;
const countEl = document.querySelector<HTMLSpanElement>("#fx-count")!;

let sessionId: string | null = null;
let tmuxSession = "";
let rootLabel = "";
let focusTerminal: () => void = () => {};
let subPath = ""; // relative to the repo root; "" at the root
let entries: FsEntry[] = [];
let cursor = 0;
let filter = "";
let filtering = false;
let showHidden = false;
let loading = false;
let loadError: string | null = null;

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
  filter = "";
  filtering = false;
  showHidden = false;
  el.classList.remove("hidden");
  await load();
  listEl.focus();
}

export function closeExplorer(): void {
  sessionId = null;
  el.classList.add("hidden");
}

/** Filtered view of the current directory. */
function visible(): FsEntry[] {
  if (!filter) return entries;
  const q = filter.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(q));
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

function render(): void {
  renderCrumbs();
  const list = visible();
  if (cursor >= list.length) cursor = Math.max(0, list.length - 1);

  listEl.innerHTML = "";
  if (loadError) {
    const err = document.createElement("div");
    err.className = "fx-empty fx-error";
    err.textContent = `Couldn't read this folder — ${loadError}`;
    listEl.appendChild(err);
  } else if (loading && !list.length) {
    const busy = document.createElement("div");
    busy.className = "fx-empty";
    busy.textContent = "Reading folder…";
    listEl.appendChild(busy);
  } else if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "fx-empty";
    empty.textContent = filter ? "No matches." : "Empty directory.";
    listEl.appendChild(empty);
  }
  list.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "fx-row" + (entry.is_dir ? " dir" : "") + (i === cursor ? " cursor" : "");
    row.id = `fx-row-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === cursor));
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
  filterEl.textContent = `/${filter}`;
  filterEl.classList.toggle("hidden", !filtering);
  countEl.textContent = list.length ? `${cursor + 1}/${list.length}` : "0";
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
  filter = "";
  filtering = false;
  void load();
}

function goUp(): void {
  if (!subPath) return;
  const parts = subPath.split("/");
  parts.pop();
  subPath = parts.join("/");
  filter = "";
  filtering = false;
  void load();
}

/** Open the entry under the cursor: descend into a dir, or reference a file. */
function openEntry(): void {
  const entry = visible()[cursor];
  if (!entry) return;
  if (entry.is_dir) {
    subPath = subPath ? `${subPath}/${entry.name}` : entry.name;
    filter = "";
    filtering = false;
    void load();
    return;
  }
  const rel = subPath ? `${subPath}/${entry.name}` : entry.name;
  void invoke("write_pty", { tmuxSession, data: `@${rel} ` }).catch((e) =>
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

listEl.addEventListener("keydown", (e) => {
  if (!isExplorerOpen()) return;
  const key = e.key;

  // Filter mode captures printable input; everything else is a command.
  if (filtering) {
    if (key === "Escape") {
      filter = "";
      filtering = false;
      render();
    } else if (key === "Enter" || key === "ArrowRight") {
      openEntry();
    } else if (key === "ArrowDown") {
      move(1);
    } else if (key === "ArrowUp") {
      move(-1);
    } else if (key === "Backspace") {
      filter = filter.slice(0, -1);
      cursor = 0;
      render();
    } else if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      filter += key;
      cursor = 0;
      render();
    } else {
      return; // let the key through
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  switch (key) {
    case "ArrowDown":
    case "j":
      move(1);
      break;
    case "ArrowUp":
    case "k":
      move(-1);
      break;
    case "Enter":
    case "ArrowRight":
    case "l":
      openEntry();
      break;
    case "Backspace":
    case "ArrowLeft":
    case "h":
      goUp();
      break;
    case "Home":
      cursor = 0;
      render();
      break;
    case "End":
      cursor = Math.max(0, visible().length - 1);
      render();
      break;
    case "/":
      filtering = true;
      filter = "";
      render();
      break;
    case ".":
      showHidden = !showHidden;
      void load();
      break;
    case "Escape":
      closeExplorer();
      focusTerminal();
      break;
    default:
      return; // don't swallow keys we don't handle
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
