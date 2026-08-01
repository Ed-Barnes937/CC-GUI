// Markdown viewer: a distraction-free reader for the active session's repo
// docs (plans, design docs, READMEs), toggled with Cmd+M. A centered column
// renders the file with @tanstack/markdown; the bar above it is a search-style
// button that drops a fuzzy file picker over every *.md in the worktree
// (backed by `list_markdown_files` / `read_session_file` in
// src-tauri/src/files.rs). In-repo .md links open in the viewer; anchors
// scroll; everything else is inert.

import { invoke } from "@tauri-apps/api/core";
import { parseMarkdown } from "@tanstack/markdown/parser";
import { renderHtml } from "@tanstack/markdown/html";
import { toast } from "./toast";

type OpenParams = {
  sessionId: string;
  focusTerminal: () => void;
  /** Optional file to open immediately (repo-relative). */
  initialPath?: string;
};

let sessionId: string | null = null;
let focusTerminal: () => void = () => {};
let files: string[] = [];
let current: string | null = null;

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
  try {
    files = await invoke<string[]>("list_markdown_files", { sessionId });
  } catch (e) {
    toast(`could not list markdown files: ${e}`, "error");
    files = [];
  }
  const initial =
    params.initialPath && files.includes(params.initialPath)
      ? params.initialPath
      : (files.find((f) => f.toLowerCase() === "readme.md") ?? null);
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
}

export function closeMarkdownViewer(): void {
  sessionId = null;
  current = null;
  closePicker();
  root.classList.add("hidden");
  focusTerminal();
}

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
    doc.innerHTML = "";
    toast(`could not read ${path}: ${e}`, "error");
    return;
  }
  if (current !== path) return; // switched while reading
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
      if (target && files.includes(target)) void showFile(target);
      else toast("only in-repo .md links open here");
    });
  });
  doc.scrollTop = 0;
  panel.focus();
}

/** Resolve `href` against the directory of `from`; null if not an in-repo .md. */
function resolveRelative(from: string, href: string): string | null {
  if (/^[a-z]+:/i.test(href)) return null;
  const clean = href.split("#")[0];
  if (!clean.toLowerCase().endsWith(".md")) return null;
  const base = from.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
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
}

function closePicker(): void {
  picker.classList.add("hidden");
}

/** Subsequence match, same spirit as the command palette. */
function matches(): string[] {
  const q = input.value.toLowerCase();
  return files.filter((f) => {
    let i = 0;
    for (const c of f.toLowerCase()) if (c === q[i]) i++;
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
