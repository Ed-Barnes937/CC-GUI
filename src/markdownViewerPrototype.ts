/// <reference types="vite/client" />
// PROTOTYPE — markdown viewer. Three structurally different variants of a
// repo markdown viewer, switchable via a `?variant=` search param and a
// floating bottom bar (← / →). Rendering: @tanstack/markdown. Backed by the
// throwaway `list_markdown_files` / `read_session_file` commands in
// src-tauri/src/files.rs. Everything here (DOM, styles, wiring) is throwaway;
// delete this file + the two Rust commands + the main.ts hooks together.
//
// Plan: "Three variants of a markdown viewer, on the running app, over the
// active session's repo: A = docs-site (sidebar tree + doc), B = reader
// (chrome-free centered column + fuzzy picker), C = side rail (docked panel +
// outline, terminals stay visible)."

import { invoke } from "@tauri-apps/api/core";
import { parseMarkdown } from "@tanstack/markdown/parser";
import { renderHtml } from "@tanstack/markdown/html";
import type { MarkdownDocument } from "@tanstack/markdown";
import { toast } from "./toast";

type Variant = "A" | "B" | "C";
const VARIANTS: { key: Variant; name: string }[] = [
  { key: "A", name: "Docs site" },
  { key: "B", name: "Reader" },
  { key: "C", name: "Side rail" },
];

type OpenParams = {
  sessionId: string;
  rootLabel: string;
  focusTerminal: () => void;
  /** Optional file to open immediately (repo-relative). */
  initialPath?: string;
};

let sessionId: string | null = null;
let rootLabel = "";
let focusTerminal: () => void = () => {};
let files: string[] = [];
let current: string | null = null;
const docCache = new Map<string, MarkdownDocument>();

function variant(): Variant {
  const v = new URLSearchParams(location.search).get("variant");
  return v === "B" || v === "C" ? v : "A";
}

function setVariant(v: Variant): void {
  const url = new URL(location.href);
  url.searchParams.set("variant", v);
  history.replaceState(null, "", url);
  render();
}

function cycleVariant(delta: number): void {
  const i = VARIANTS.findIndex((v) => v.key === variant());
  setVariant(VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length].key);
}

// ------------------------------------------------------------------- mount

const root = document.createElement("div");
root.id = "mdv-root";
root.className = "hidden";
document.body.appendChild(root);

const switcher = document.createElement("div");
switcher.id = "mdv-switcher";
switcher.className = "hidden";
document.body.appendChild(switcher);

export function isMarkdownViewerOpen(): boolean {
  return !root.classList.contains("hidden");
}

export async function openMarkdownViewer(params: OpenParams): Promise<void> {
  sessionId = params.sessionId;
  rootLabel = params.rootLabel;
  focusTerminal = params.focusTerminal;
  root.classList.remove("hidden");
  if (import.meta.env.DEV) switcher.classList.remove("hidden");
  try {
    files = await invoke<string[]>("list_markdown_files", { sessionId });
  } catch (e) {
    toast(`could not list markdown files: ${e}`, "error");
    files = [];
  }
  current =
    params.initialPath && files.includes(params.initialPath)
      ? params.initialPath
      : (files.find((f) => f.toLowerCase() === "readme.md") ?? files[0] ?? null);
  render();
}

export function closeMarkdownViewer(): void {
  sessionId = null;
  docCache.clear();
  root.classList.add("hidden");
  switcher.classList.add("hidden");
  focusTerminal();
}

async function loadDoc(path: string): Promise<MarkdownDocument | null> {
  const cached = docCache.get(path);
  if (cached) return cached;
  if (!sessionId) return null;
  try {
    const src = await invoke<string>("read_session_file", { sessionId, relPath: path });
    const doc = parseMarkdown(src, { frontmatter: true });
    docCache.set(path, doc);
    return doc;
  } catch (e) {
    toast(`could not read ${path}: ${e}`, "error");
    return null;
  }
}

function openFile(path: string): void {
  current = path;
  render();
}

// ------------------------------------------------------------ shared bits

/** Render the current doc's HTML into `container`, wiring relative .md links
 *  to open in the viewer. */
async function renderDocInto(container: HTMLElement): Promise<void> {
  container.innerHTML = "";
  if (!current) {
    const empty = document.createElement("div");
    empty.className = "mdv-empty";
    empty.textContent = files.length ? "Pick a file." : "No markdown files in this repo.";
    container.appendChild(empty);
    return;
  }
  const path = current;
  container.innerHTML = `<div class="mdv-empty">Reading ${path}…</div>`;
  const doc = await loadDoc(path);
  if (current !== path || !doc) return;
  container.innerHTML = renderHtml(doc);
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        container.querySelector(href)?.scrollIntoView({ block: "start" });
        return;
      }
      const target = resolveRelative(path, href);
      if (target && files.includes(target)) openFile(target);
      else toast("only in-repo .md links open here (prototype)");
    });
  });
  container.scrollTop = 0;
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function closeButton(): HTMLButtonElement {
  const btn = el("button", "mdv-close", "×");
  btn.title = "Close (Esc)";
  btn.addEventListener("click", closeMarkdownViewer);
  return btn;
}

// ---------------------------------------------------------------- variants

function render(): void {
  if (!isMarkdownViewerOpen()) return;
  root.innerHTML = "";
  root.dataset.variant = variant();
  ({ A: renderDocsSite, B: renderReader, C: renderSideRail })[variant()]();
  renderSwitcher();
  // Take focus off the terminal's xterm textarea so Esc / arrow keys reach the
  // viewer's handler instead of reading as typing.
  const panel = root.querySelector<HTMLElement>(".mdv-panel");
  if (panel) {
    panel.tabIndex = -1;
    panel.focus();
  }
}

// Variant A — "Docs site": fullscreen, persistent sidebar of files grouped by
// directory, document fills the rest. Information-dense, browse-first.
function renderDocsSite(): void {
  const panel = el("div", "mdv-panel mdv-a");
  const header = el("div", "mdv-header");
  header.appendChild(el("span", "mdv-title", `${rootLabel} — markdown`));
  header.appendChild(el("span", "mdv-path", current ?? ""));
  header.appendChild(closeButton());
  panel.appendChild(header);

  const body = el("div", "mdv-a-body");
  const side = el("div", "mdv-a-side");
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.includes("/") ? f.split("/").slice(0, -1).join("/") : ".";
    (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(f);
  }
  for (const [dir, paths] of groups) {
    side.appendChild(el("div", "mdv-a-dir", dir === "." ? "repo root" : dir));
    for (const p of paths) {
      const row = el("div", "mdv-a-file" + (p === current ? " active" : ""), p.split("/").pop()!);
      row.addEventListener("click", () => openFile(p));
      side.appendChild(row);
    }
  }
  body.appendChild(side);
  const doc = el("div", "mdv-doc mdv-a-doc");
  body.appendChild(doc);
  panel.appendChild(body);
  root.appendChild(panel);
  void renderDocInto(doc);
}

// Variant B — "Reader": chrome-free centered column over a scrim. No
// persistent file list; a fuzzy picker drops down from the filename bar.
// Reading-first — for sitting with one plan.
function renderReader(): void {
  const panel = el("div", "mdv-panel mdv-b");
  const bar = el("div", "mdv-b-bar");
  const nameBtn = el("button", "mdv-b-name", current ?? "choose a file…");
  bar.appendChild(nameBtn);
  bar.appendChild(closeButton());
  panel.appendChild(bar);

  const picker = el("div", "mdv-b-picker hidden");
  const input = document.createElement("input");
  input.className = "mdv-b-input";
  input.placeholder = "Fuzzy find a markdown file…";
  const list = el("div", "mdv-b-list");
  picker.appendChild(input);
  picker.appendChild(list);
  panel.appendChild(picker);

  let cursor = 0;
  const matches = () => {
    const q = input.value.toLowerCase();
    return files.filter((f) => {
      let i = 0;
      for (const c of f.toLowerCase()) if (c === q[i]) i++;
      return i === q.length;
    });
  };
  const renderList = () => {
    const m = matches();
    if (cursor >= m.length) cursor = Math.max(0, m.length - 1);
    list.innerHTML = "";
    m.slice(0, 12).forEach((f, i) => {
      const row = el("div", "mdv-b-row" + (i === cursor ? " cursor" : ""), f);
      row.addEventListener("click", () => openFile(f));
      list.appendChild(row);
    });
  };
  nameBtn.addEventListener("click", () => {
    picker.classList.toggle("hidden");
    if (!picker.classList.contains("hidden")) {
      input.value = "";
      cursor = 0;
      renderList();
      input.focus();
    }
  });
  input.addEventListener("input", () => {
    cursor = 0;
    renderList();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") cursor++;
    else if (e.key === "ArrowUp") cursor = Math.max(0, cursor - 1);
    else if (e.key === "Enter") {
      const m = matches();
      if (m[cursor]) openFile(m[cursor]);
      return;
    } else if (e.key === "Escape") {
      picker.classList.add("hidden");
      return;
    } else return;
    e.preventDefault();
    renderList();
  });

  const doc = el("div", "mdv-doc mdv-b-doc");
  panel.appendChild(doc);
  root.appendChild(panel);
  void renderDocInto(doc);
}

// Variant C — "Side rail": right-docked sheet, no scrim, terminals stay
// visible and usable. Compact file dropdown + heading outline. For keeping a
// plan open while the session works.
function renderSideRail(): void {
  const panel = el("div", "mdv-panel mdv-c");
  const bar = el("div", "mdv-c-bar");
  const select = document.createElement("select");
  select.className = "mdv-c-select";
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    opt.selected = f === current;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => openFile(select.value));
  bar.appendChild(select);
  bar.appendChild(closeButton());
  panel.appendChild(bar);

  const body = el("div", "mdv-c-body");
  const outline = el("div", "mdv-c-outline");
  const doc = el("div", "mdv-doc mdv-c-doc");
  body.appendChild(outline);
  body.appendChild(doc);
  panel.appendChild(body);
  root.appendChild(panel);

  void renderDocInto(doc).then(() => {
    outline.innerHTML = "";
    doc.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((h) => {
      const item = el("div", `mdv-c-h mdv-c-${h.tagName.toLowerCase()}`, h.textContent ?? "");
      item.addEventListener("click", () => h.scrollIntoView({ block: "start" }));
      outline.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------- switcher

function renderSwitcher(): void {
  switcher.innerHTML = "";
  const prev = el("button", "mdv-sw-btn", "←");
  prev.addEventListener("click", () => cycleVariant(-1));
  const cur = VARIANTS.find((v) => v.key === variant())!;
  const label = el("span", "mdv-sw-label", `${cur.key} — ${cur.name}`);
  const next = el("button", "mdv-sw-btn", "→");
  next.addEventListener("click", () => cycleVariant(1));
  switcher.appendChild(prev);
  switcher.appendChild(label);
  switcher.appendChild(next);
}

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
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !typing && import.meta.env.DEV) {
      e.preventDefault();
      e.stopPropagation();
      cycleVariant(e.key === "ArrowLeft" ? -1 : 1);
    }
  },
  true,
);

// ------------------------------------------------------------------ styles

const style = document.createElement("style");
style.textContent = /* css */ `
#mdv-root { display: contents; }
#mdv-root.hidden, #mdv-switcher.hidden, .mdv-b-picker.hidden { display: none; }

.mdv-panel {
  position: fixed; background: var(--bg-elevated); color: var(--text);
  font-family: var(--font-ui); z-index: 60; display: flex; flex-direction: column;
  border: 1px solid var(--border); box-shadow: var(--shadow-popover);
}
.mdv-close {
  background: none; border: none; color: var(--text-dim); font-size: 18px;
  cursor: pointer; padding: 2px 8px;
}
.mdv-close:hover { color: var(--text); }
.mdv-empty { color: var(--text-dim); padding: 24px; }

/* rendered markdown */
.mdv-doc { overflow-y: auto; padding: 20px 28px 48px; line-height: 1.6; font-size: 14px; }
.mdv-doc h1, .mdv-doc h2, .mdv-doc h3, .mdv-doc h4 { color: var(--text); margin: 1.2em 0 0.5em; line-height: 1.25; }
.mdv-doc h1 { font-size: 1.6em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.mdv-doc h2 { font-size: 1.3em; }
.mdv-doc h3 { font-size: 1.1em; }
.mdv-doc p, .mdv-doc ul, .mdv-doc ol { margin: 0.6em 0; }
.mdv-doc li { margin: 0.25em 0; }
.mdv-doc a { color: var(--accent); text-decoration: none; }
.mdv-doc a:hover { text-decoration: underline; }
.mdv-doc code { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; }
.mdv-doc pre { background: var(--bg-inset); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
.mdv-doc pre code { background: none; padding: 0; }
.mdv-doc blockquote { border-left: 3px solid var(--border-strong); margin: 0.6em 0; padding: 2px 14px; color: var(--text-muted); }
.mdv-doc table { border-collapse: collapse; margin: 0.8em 0; }
.mdv-doc th, .mdv-doc td { border: 1px solid var(--border); padding: 5px 10px; }
.mdv-doc th { background: var(--bg-inset); }
.mdv-doc hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
.mdv-doc img { max-width: 100%; }

/* A — docs site */
.mdv-a { inset: 4vh 5vw; border-radius: 10px; }
.mdv-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.mdv-title { font-weight: 600; }
.mdv-path { color: var(--text-dim); font-family: var(--font-mono); font-size: 12px; flex: 1; text-align: right; }
.mdv-a-body { display: flex; flex: 1; min-height: 0; }
.mdv-a-side { width: 240px; overflow-y: auto; border-right: 1px solid var(--border); padding: 10px 0; flex-shrink: 0; }
.mdv-a-dir { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 16px 4px; }
.mdv-a-file { padding: 4px 16px 4px 24px; font-size: 13px; cursor: pointer; color: var(--text-muted); }
.mdv-a-file:hover { background: var(--row-hover-bg); }
.mdv-a-file.active { background: var(--row-selected-bg); color: var(--text); }
.mdv-a-doc { flex: 1; }

/* B — reader */
.mdv-b { inset: 0; background: var(--scrim); border: none; box-shadow: none; align-items: center; }
.mdv-b-bar {
  display: flex; align-items: center; gap: 8px; margin-top: 5vh; padding: 6px 10px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px;
}
.mdv-b-name { background: none; border: none; color: var(--text); font-family: var(--font-mono); font-size: 13px; cursor: pointer; padding: 4px 8px; }
.mdv-b-name:hover { color: var(--accent); }
.mdv-b-picker { width: min(560px, 80vw); background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: 8px; margin-top: 6px; box-shadow: var(--shadow-popover); }
.mdv-b-input { width: 100%; box-sizing: border-box; background: none; border: none; border-bottom: 1px solid var(--border); color: var(--text); padding: 10px 14px; font-family: var(--font-mono); font-size: 13px; outline: none; }
.mdv-b-list { max-height: 40vh; overflow-y: auto; padding: 4px 0; }
.mdv-b-row { padding: 5px 14px; font-family: var(--font-mono); font-size: 13px; cursor: pointer; color: var(--text-muted); }
.mdv-b-row:hover { background: var(--row-hover-bg); }
.mdv-b-row.cursor { background: var(--row-selected-bg); color: var(--text); }
.mdv-b-doc {
  width: min(760px, 90vw); flex: 1; min-height: 0; margin: 16px 0 5vh;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  font-size: 15px; padding: 28px 48px 64px;
}

/* C — side rail */
.mdv-c { top: 0; right: 0; bottom: 0; width: min(560px, 44vw); border-width: 0 0 0 1px; }
.mdv-c-bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.mdv-c-select { flex: 1; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font-family: var(--font-mono); font-size: 12px; }
.mdv-c-body { display: flex; flex: 1; min-height: 0; }
.mdv-c-outline { width: 150px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border); padding: 12px 0; }
.mdv-c-h { font-size: 11px; color: var(--text-dim); cursor: pointer; padding: 3px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mdv-c-h:hover { color: var(--accent); }
.mdv-c-h2 { padding-left: 18px; }
.mdv-c-h3 { padding-left: 26px; }
.mdv-c-doc { flex: 1; font-size: 13px; padding: 14px 18px 40px; }

/* floating variant switcher — dev-only, deliberately loud */
#mdv-switcher {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 70;
  display: flex; align-items: center; gap: 4px; padding: 4px 6px;
  background: var(--bg-inset); border: 1px solid var(--accent); border-radius: 999px;
  box-shadow: var(--shadow-popover); font-family: var(--font-mono);
}
.mdv-sw-btn { background: none; border: none; color: var(--accent); font-size: 14px; cursor: pointer; padding: 2px 8px; }
.mdv-sw-label { color: var(--text); font-size: 12px; min-width: 110px; text-align: center; }
`;
document.head.appendChild(style);
