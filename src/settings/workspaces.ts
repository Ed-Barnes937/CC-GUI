// The Workspaces tab: the list (reorder, rename, delete), adding one, the
// startup choice and Main's label.
//
// Unlike the config tabs, nothing here goes through the pane's working copy
// and Save: every control applies at once through its own backend command, as
// the TUI does (rename and delete re-tag projects, which a config save can't
// do). The tab draws from the snapshot, so it redraws itself when one changes
// what it shows (a rename from the TUI while it's open, say), keeping
// whatever is being typed: drafts live here, not in the DOM.

import { invoke } from "@tauri-apps/api/core";
import { confirmDialog, toast } from "../toast";
import { noTextAssist } from "../dom";
import { draggable } from "../drag";
import { refreshNow } from "../app/actions";
import { registerView } from "../app/render";
import { allGroups, startupWorkspace, workspaces } from "../app/store";
import type { WorkspaceEntry } from "../app/types";
import {
  activeWorkspace,
  inWorkspace,
  setActiveWorkspace,
  validateWorkspaceLabel,
  validateWorkspaceName,
  workspaceDeleted,
  workspaceRenamed,
  type NameCheck,
} from "../app/workspaces";
import { activeCat, redrawPanel, setPendingFocusSelector } from "./state";
import { isOpen } from "./shell";

export const WORKSPACES_TAB = "workspaces";

// ------------------------------------------------------------------ drafts

/** The workspace being renamed inline (null = Main, whose name is its label)
 *  and what has been typed so far; undefined when none is. */
let renaming: { name: string | null; draft: string } | undefined;
/** The add row's input. */
let addDraft = "";
/** Main label field's text while it's being edited; null shows the label. */
let mainDraft: string | null = null;
/** Inline complaints, by control, until the next edit there. */
const errors: { add?: string; rename?: string; main?: string } = {};
/** A reorder drag is in progress: a redraw would pull the row from under it. */
let dragging = false;

const ID = {
  add: "ws-add",
  rename: "ws-rename",
  startup: "ws-startup",
  main: "ws-main-label",
  handle: (i: number) => `ws-handle-${i}`,
};

// ---------------------------------------------------------- liveness

// What the tab last drew, so a snapshot that changes nothing it shows (most
// of them) doesn't rebuild it under the pointer or close an open select.
let drawn: string | null = null;

function signature(): string {
  const groups = allGroups();
  return JSON.stringify([
    workspaces(),
    startupWorkspace(),
    workspaces().map((w) => groups.filter((g) => inWorkspace(g, w.name)).map((g) => g.name)),
  ]);
}

function showing(): boolean {
  return isOpen() && activeCat() === WORKSPACES_TAB;
}

/** Redraw if a snapshot changed what the tab shows. */
function redrawIfChanged(): void {
  if (showing() && !dragging && signature() !== drawn) redrawPanel();
}

registerView("settings", redrawIfChanged);

/** After an edit: pull a fresh snapshot, and redraw even if it changed
 *  nothing (a refused edit must put back what the control showed). */
async function settle(): Promise<void> {
  drawn = null;
  await refreshNow();
  redrawIfChanged();
}

/** Start the tab fresh (the pane is opening). */
export function resetWorkspacesTab(): void {
  renaming = undefined;
  addDraft = "";
  mainDraft = null;
  delete errors.add;
  delete errors.rename;
  delete errors.main;
}

// ------------------------------------------------------------------ edits

const projectsIn = (name: string | null) =>
  allGroups()
    .filter((g) => inWorkspace(g, name))
    .map((g) => g.name);

const countLabel = (n: number) => `${n} ${n === 1 ? "project" : "projects"}`;

async function addWorkspace(): Promise<void> {
  const check = validateWorkspaceName(addDraft, workspaces());
  if (!check.ok) return complain("add", check.error, ID.add);
  try {
    await invoke<string>("create_workspace", { name: check.name });
    addDraft = "";
    setPendingFocusSelector(`#${ID.add}`);
  } catch (e) {
    toast(`Couldn't create the workspace: ${e}`, "error");
  }
  await settle();
}

// One edit at a time per field: Enter, then the blur or change it causes,
// must not send it twice.
let renameBusy = false;
let mainBusy = false;

async function commitRename(): Promise<void> {
  if (!renaming || renameBusy) return;
  const { name, draft } = renaming;
  const entry = workspaces().find((w) => w.name === name);
  if (!entry || draft.trim() === entry.label) {
    // Unchanged, or renamed/deleted elsewhere while the field was open.
    renaming = undefined;
    delete errors.rename;
    return redrawPanel();
  }
  const check: NameCheck =
    name === null ? validateWorkspaceLabel(draft, workspaces()) : validateWorkspaceName(draft, workspaces(), entry);
  if (!check.ok) return complain("rename", check.error, ID.rename);
  renameBusy = true;
  try {
    if (name === null) {
      // Main's name is its label.
      await invoke("set_main_workspace_label", { label: check.name });
    } else {
      const wasActive = activeWorkspace() === name;
      await invoke<boolean>("rename_workspace", { from: name, to: check.name });
      workspaceRenamed(name, check.name, wasActive);
    }
    renaming = undefined;
  } catch (e) {
    toast(`Couldn't rename the workspace: ${e}`, "error");
  } finally {
    renameBusy = false;
  }
  await settle();
}

async function commitMainLabel(): Promise<void> {
  if (mainDraft === null || mainBusy) return;
  const draft = mainDraft;
  if (draft.trim() === workspaces()[0].label) {
    mainDraft = null;
    delete errors.main;
    return redrawPanel();
  }
  const check = validateWorkspaceLabel(draft, workspaces());
  if (!check.ok) return complain("main", check.error, ID.main);
  mainBusy = true;
  try {
    await invoke("set_main_workspace_label", { label: check.name });
    mainDraft = null;
  } catch (e) {
    toast(`Couldn't rename the workspace: ${e}`, "error");
  } finally {
    mainBusy = false;
  }
  await settle();
}

async function setStartup(value: string): Promise<void> {
  try {
    await invoke("set_startup_workspace", { value });
  } catch (e) {
    toast(`Couldn't set the startup workspace: ${e}`, "error");
  }
  await settle();
}

/** Move the named workspace `from` to position `to` among the named ones
 *  (Main always stays first). */
async function reorder(from: number, to: number): Promise<void> {
  const names = workspaces().flatMap((w) => (w.name === null ? [] : [w.name]));
  if (to < 0 || to >= names.length || from === to) return;
  const [moved] = names.splice(from, 1);
  names.splice(to, 0, moved);
  try {
    await invoke("reorder_workspaces", { names });
  } catch (e) {
    toast(`Couldn't reorder the workspaces: ${e}`, "error");
  }
  await settle();
}

/** The confirm copy (handoff 1e): which projects move to Main. */
export function deleteMessage(label: string, projects: string[], mainLabel: string): string {
  const head = `Delete workspace "${label}"?`;
  if (projects.length === 0) return `${head}\nIt has no projects. No sessions are stopped.`;
  const its = projects.length === 1 ? "Its 1 project" : `Its ${projects.length} projects`;
  const verb = projects.length === 1 ? "moves" : "move";
  return `${head}\n${its} (${projects.join(", ")}) ${verb} to ${mainLabel}. No sessions are stopped.`;
}

async function deleteWorkspace(w: WorkspaceEntry): Promise<void> {
  const name = w.name;
  if (name === null) return; // Main can't be deleted
  const ok = await confirmDialog(deleteMessage(w.label, projectsIn(name), workspaces()[0].label), "Delete");
  if (!ok) return;
  // Leave it first, so its view is remembered and dropped with it rather than
  // the screen emptying under a vanished workspace.
  if (activeWorkspace() === name) setActiveWorkspace(null, "switch");
  try {
    await invoke<boolean>("delete_workspace", { name });
    workspaceDeleted(name);
    if (renaming?.name === name) renaming = undefined;
  } catch (e) {
    toast(`Couldn't delete the workspace: ${e}`, "error");
  }
  await settle();
}

/** Show `message` under `control` and put focus back there. */
function complain(control: keyof typeof errors, message: string, id: string): void {
  errors[control] = message;
  setPendingFocusSelector(`#${id}`);
  redrawPanel();
}

// ------------------------------------------------------------------ render

export function renderWorkspacesTab(panel: HTMLElement): void {
  const list = workspaces();
  // A workspace renamed or deleted elsewhere takes its open rename with it.
  if (renaming && !list.some((w) => w.name === renaming?.name)) {
    renaming = undefined;
    delete errors.rename;
  }
  drawn = signature();

  const box = document.createElement("div");
  box.className = "ws-list";
  list.forEach((w, i) => box.appendChild(workspaceRow(w, i, box)));
  box.appendChild(addRow());
  panel.appendChild(box);

  panel.append(startupField(list), mainLabelField(list[0]));
}

function workspaceRow(w: WorkspaceEntry, index: number, box: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "ws-row";
  row.dataset.workspace = w.name ?? "";
  const isMain = w.name === null;

  // Main is always first, so it has no handle; the slot keeps the columns.
  const handle = document.createElement("button");
  handle.className = "ws-handle";
  handle.textContent = "⋮⋮";
  if (isMain) {
    handle.classList.add("placeholder");
    handle.tabIndex = -1;
    handle.setAttribute("aria-hidden", "true");
  } else {
    handle.id = ID.handle(index);
    handle.title = "Drag to reorder (or use the arrow keys)";
    handle.setAttribute("aria-label", `Reorder ${w.label}`);
    wireReorder(handle, row, index - 1, box);
  }
  row.appendChild(handle);

  const editing = renaming && renaming.name === w.name;
  if (editing) {
    row.appendChild(renameInput(w));
  } else {
    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = w.label;
    name.title = w.label;
    row.appendChild(name);
  }
  if (isMain) {
    const tag = document.createElement("span");
    tag.className = "ws-tag";
    tag.textContent = "built-in";
    row.appendChild(tag);
  }

  const spacer = document.createElement("span");
  spacer.className = "ws-spacer";
  const count = document.createElement("span");
  count.className = "ws-count";
  count.textContent = countLabel(projectsIn(w.name).length);
  row.append(spacer, count);

  const theme = themeControl(w);
  if (theme) row.appendChild(theme);

  const rename = document.createElement("button");
  rename.className = "row-action ws-rename-btn";
  rename.textContent = "✎";
  rename.title = "Rename";
  rename.setAttribute("aria-label", `Rename ${w.label}`);
  rename.addEventListener("click", () => {
    renaming = { name: w.name, draft: w.label };
    delete errors.rename;
    setPendingFocusSelector(`#${ID.rename}`);
    redrawPanel();
  });

  const del = document.createElement("button");
  del.className = "row-action ws-delete-btn";
  del.textContent = "✕";
  if (isMain) {
    // Main can't be deleted; the hidden button keeps the columns aligned.
    del.classList.add("placeholder");
    del.tabIndex = -1;
    del.setAttribute("aria-hidden", "true");
  } else {
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete ${w.label}`);
    del.addEventListener("click", () => void deleteWorkspace(w));
  }
  row.append(rename, del);

  if (editing && errors.rename) {
    const wrap = document.createElement("div");
    wrap.className = "ws-row-wrap";
    wrap.append(row, errorLine(errors.rename));
    return wrap;
  }
  return row;
}

/**
 * The row's per-workspace theme picker. Per-workspace themes aren't wired yet,
 * so there's none to show; when they are, this returns the select (150px,
 * "Global theme" + every palette) and the row lays it out before ✎.
 */
function themeControl(_w: WorkspaceEntry): HTMLElement | null {
  return null;
}

function renameInput(w: WorkspaceEntry): HTMLInputElement {
  const input = noTextAssist(document.createElement("input"));
  input.type = "text";
  input.id = ID.rename;
  input.className = "ws-rename-input";
  input.value = renaming?.draft ?? w.label;
  input.setAttribute("aria-label", `New name for ${w.label}`);
  input.addEventListener("input", () => {
    if (renaming) renaming.draft = input.value;
    if (errors.rename) {
      delete errors.rename;
      input.closest(".ws-row-wrap")?.querySelector(".ws-error")?.remove();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      // Cancel the rename, not the whole pane.
      e.preventDefault();
      e.stopPropagation();
      renaming = undefined;
      delete errors.rename;
      setPendingFocusSelector(`.ws-row[data-workspace="${CSS.escape(w.name ?? "")}"] .ws-rename-btn`);
      redrawPanel();
    }
  });
  // Clicking away keeps what was typed, like Enter. A rebuild that replaces
  // the field (a snapshot) doesn't count: the draft survives it. Checked a
  // tick later, once a rebuild has settled whether this field is still the one.
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (input.isConnected && document.activeElement !== input) void commitRename();
    }, 0);
  });
  return input;
}

function addRow(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ws-add-wrap";
  const row = document.createElement("div");
  row.className = "ws-add";
  const input = noTextAssist(document.createElement("input"));
  input.type = "text";
  input.id = ID.add;
  input.placeholder = "New workspace name";
  input.setAttribute("aria-label", "New workspace name");
  input.value = addDraft;
  input.addEventListener("input", () => {
    addDraft = input.value;
    if (errors.add) {
      delete errors.add;
      wrap.querySelector(".ws-error")?.remove();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addWorkspace();
    }
  });
  const add = document.createElement("button");
  add.className = "row-action ws-add-btn";
  add.textContent = "＋ Add";
  add.addEventListener("click", () => void addWorkspace());
  row.append(input, add);
  wrap.appendChild(row);
  if (errors.add) wrap.appendChild(errorLine(errors.add));
  return wrap;
}

function errorLine(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ws-error";
  el.setAttribute("role", "alert");
  el.textContent = message;
  return el;
}

function fieldHead(forId: string, label: string, desc: string): HTMLElement {
  const head = document.createElement("div");
  head.className = "settings-field-head";
  const l = document.createElement("label");
  l.className = "settings-field-label";
  l.htmlFor = forId;
  l.textContent = label;
  const d = document.createElement("div");
  d.className = "settings-field-desc";
  d.textContent = desc;
  head.append(l, d);
  return head;
}

function startupField(list: WorkspaceEntry[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-field";
  const select = document.createElement("select");
  select.id = ID.startup;
  const options: { value: string; label: string }[] = [
    { value: "last", label: "Last used" },
    { value: "main", label: list[0].label },
    ...list.flatMap((w) => (w.name === null ? [] : [{ value: w.name, label: w.label }])),
  ];
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = startupWorkspace();
  // A pin on a name the list no longer has (mid-delete) reads as Main, which
  // is where upstream's resolution lands.
  if (select.selectedIndex < 0) select.value = "main";
  select.addEventListener("change", () => void setStartup(select.value));
  row.append(
    fieldHead(
      ID.startup,
      "Open on launch",
      "Which workspace CC-GUI starts in. A named workspace falls back to Main if it's deleted.",
    ),
    select,
  );
  return row;
}

function mainLabelField(main: WorkspaceEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-field";
  const head = fieldHead(ID.main, "Main label", "Display name for the built-in workspace that holds untagged projects.");
  const input = noTextAssist(document.createElement("input"));
  input.type = "text";
  input.id = ID.main;
  input.value = mainDraft ?? main.label;
  input.placeholder = "Main";
  input.addEventListener("input", () => {
    mainDraft = input.value;
    if (errors.main) {
      delete errors.main;
      head.querySelector(".ws-error")?.remove();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitMainLabel();
    } else if (e.key === "Escape" && mainDraft !== null) {
      // Put the label back, rather than closing the pane.
      e.preventDefault();
      e.stopPropagation();
      mainDraft = null;
      delete errors.main;
      setPendingFocusSelector(`#${ID.main}`);
      redrawPanel();
    }
  });
  input.addEventListener("change", () => void commitMainLabel());
  if (errors.main) head.appendChild(errorLine(errors.main));
  row.append(head, input);
  return row;
}

// ----------------------------------------------------------------- reorder

/** Drag the handle to a new place in the list, or press ArrowUp/ArrowDown on
 *  it. `at` is the workspace's index among the named ones. */
function wireReorder(handle: HTMLElement, row: HTMLElement, at: number, box: HTMLElement): void {
  handle.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const named = workspaces().length - 1;
    const to = at + step;
    if (to < 0 || to >= named) return;
    // Focus follows the row to its new place (row index = named index + 1).
    setPendingFocusSelector(`#${ID.handle(to + 1)}`);
    void reorder(at, to);
  });

  draggable(handle, () => {
    dragging = true;
    row.classList.add("dragging");
    const rows = () => [...box.querySelectorAll<HTMLElement>(".ws-row")].slice(1); // never above Main
    let target: number | null = null;
    const clear = () => rows().forEach((r) => r.classList.remove("drop-before", "drop-after"));
    return {
      onMove(_x, y) {
        clear();
        const named = rows();
        // The slot the pointer is over: before the first row whose middle is below it.
        let slot = named.findIndex((r) => {
          const b = r.getBoundingClientRect();
          return y < b.top + b.height / 2;
        });
        if (slot === -1) slot = named.length;
        // Dropping just before or after itself goes nowhere.
        target = slot > at ? slot - 1 : slot;
        if (target === at) return;
        if (slot < named.length) named[slot].classList.add("drop-before");
        else named[named.length - 1]?.classList.add("drop-after");
      },
      onDrop() {
        if (target !== null && target !== at) void reorder(at, target);
      },
      onEnd() {
        dragging = false;
        row.classList.remove("dragging");
        clear();
        // A snapshot held back by the drag may be waiting.
        redrawIfChanged();
      },
    };
  });
}
