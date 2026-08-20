// Settings modal: a categorized, typed editor behind a single searchable nav.
//
// One nav lists every category: the claude-commander Config ones (round-tripped
// through `save_config`) plus the GUI-only ones -- Appearance (theming) and
// Features (optional-feature switches) -- which apply live to localStorage and
// never touch `save_config`. The search box filters categories by their label
// and their fields' labels/descriptions.
//
// This module is the renderer and the save/load flow; the schema, the controls,
// and the two custom tabs are beside it. On save we deep-clone the loaded config
// and overwrite only the edited leaves, so keys we don't render (keybindings,
// theme overrides) survive untouched.

import { invoke } from "@tauri-apps/api/core";
import { toast, confirmDialog } from "../toast";
import { noTextAssist } from "../dom";
import { CATEGORIES, CATEGORY_ICONS, type Category, type Config } from "./schema";
import { makeControl } from "./controls";
import { renderFeatures, renderTheme } from "./panels";
import { decodeSections, encodeSections, renderSections, replaceSectionDrafts, sectionDrafts } from "./sections";
import { box, closeSettings, isOpen, openOverlay, overlay } from "./shell";
import {
  activeCat,
  fieldId,
  getPath,
  registerPanelRedraw,
  replaceWorking,
  searchQuery,
  setActiveCat,
  setSearchQuery,
  takePendingFocusSelector,
  working,
} from "./state";

// The config the pane last loaded (as it would be saved), so we can tell whether
// there are unsaved edits before discarding them. Set on open.
let originalJson = "";
// The Save button, held so save feedback can disable/relabel it in flight.
let saveBtn: HTMLButtonElement | null = null;

/** Categories whose label — or any field label/description — matches the
 *  search query. All of them when the query is blank. */
function visibleCategories(): Category[] {
  const q = searchQuery().trim().toLowerCase();
  if (!q) return CATEGORIES;
  return CATEGORIES.filter((cat) => {
    if (cat.label.toLowerCase().includes(q)) return true;
    if (!("fields" in cat)) return false;
    return cat.fields.some(
      (f) => f.label.toLowerCase().includes(q) || (f.desc ?? "").toLowerCase().includes(q),
    );
  });
}

function render(): void {
  box.innerHTML = "";

  const body = document.createElement("div");
  body.className = "settings-body";

  const nav = document.createElement("div");
  nav.className = "settings-nav";

  const title = document.createElement("div");
  title.className = "settings-nav-title";
  title.textContent = "Settings";

  const search = noTextAssist(document.createElement("input"));
  search.type = "text";
  search.className = "settings-search";
  search.placeholder = "⌕ Search settings…";
  search.setAttribute("aria-label", "Search settings");
  search.value = searchQuery();
  search.addEventListener("input", () => {
    setSearchQuery(search.value);
    renderNav(navList);
    renderPanel();
  });

  const navList = document.createElement("div");
  navList.className = "settings-nav-list";
  navList.addEventListener("keydown", (e) => onNavKeydown(e, navList));
  renderNav(navList);

  nav.append(title, search, navList);

  const panel = document.createElement("div");
  panel.className = "settings-panel";
  body.append(nav, panel);
  box.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "editor-buttons";
  const cancel = document.createElement("button");
  cancel.className = "row-action";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => void requestClose());
  const save = document.createElement("button");
  save.className = "row-action";
  save.textContent = "Save";
  save.addEventListener("click", () => void saveSettings());
  saveBtn = save;
  footer.append(cancel, save);
  box.appendChild(footer);

  renderPanel();
  // Land keyboard focus in the search box so the whole pane is reachable by
  // typing or arrowing from the first keystroke.
  setTimeout(() => search.focus(), 0);
}

/** Roving keyboard navigation for the category nav: arrows and Home/End move
 *  focus between categories, and a printable key jumps to the next category
 *  whose label starts with it (type-ahead). Enter/Space activate natively. */
function onNavKeydown(e: KeyboardEvent, navList: HTMLElement): void {
  const items = [...navList.querySelectorAll<HTMLElement>(".settings-nav-item")];
  if (items.length === 0) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    items[cur < 0 ? 0 : Math.min(items.length - 1, cur + 1)].focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    items[cur <= 0 ? 0 : cur - 1].focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    items[0].focus();
  } else if (e.key === "End") {
    e.preventDefault();
    items[items.length - 1].focus();
  } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const ch = e.key.toLowerCase();
    for (let k = 1; k <= items.length; k++) {
      const it = items[((cur < 0 ? 0 : cur) + k) % items.length];
      // The label is the text node after the icon span (see renderNav).
      if ((it.lastChild?.textContent ?? "").trim().toLowerCase().startsWith(ch)) {
        e.preventDefault();
        it.focus();
        break;
      }
    }
  }
}

/** Fill the nav list with the categories matching the current search. When the
 *  active category is filtered out, the first match becomes active. */
function renderNav(navList: HTMLElement): void {
  navList.innerHTML = "";
  const cats = visibleCategories();
  if (cats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-nav-empty";
    empty.textContent = "No matches";
    navList.appendChild(empty);
    return;
  }
  if (!cats.some((c) => c.id === activeCat())) setActiveCat(cats[0].id);
  for (const cat of cats) {
    const item = document.createElement("button");
    item.className = "settings-nav-item";
    const isActive = cat.id === activeCat();
    item.classList.toggle("active", isActive);
    if (isActive) item.setAttribute("aria-current", "true");
    const icon = document.createElement("span");
    icon.className = "settings-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = CATEGORY_ICONS[cat.id] ?? "·";
    item.append(icon, document.createTextNode(cat.label));
    item.dataset.cat = cat.id;
    item.addEventListener("click", () => {
      setActiveCat(cat.id);
      renderNav(navList);
      renderPanel();
      // Keep focus on the now-active category so arrow-nav and type-ahead can
      // continue from here after a keyboard (Enter/Space) activation.
      navList.querySelector<HTMLElement>(".settings-nav-item.active")?.focus();
    });
    navList.appendChild(item);
  }
}

/** A selector that re-finds the focused control after a panel rebuild, plus its
 *  caret, or null when focus is outside the panel (nothing to preserve). */
type PanelFocus = { sel: string; start: number | null; end: number | null };

function capturePanelFocus(panel: HTMLElement): PanelFocus | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !panel.contains(el)) return null;
  let sel: string | null = null;
  if (el.id) {
    sel = `#${CSS.escape(el.id)}`;
  } else {
    const field = el.getAttribute("data-section-field");
    const idx = el.closest<HTMLElement>(".section-card")?.dataset.sectionIndex;
    if (field && idx != null) {
      sel = `.section-card[data-section-index="${idx}"] [data-section-field="${field}"]`;
    }
  }
  if (!sel) return null;
  let start: number | null = null;
  let end: number | null = null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      start = end = null; // number/range inputs forbid selection access
    }
  }
  return { sel, start, end };
}

function restorePanelFocus(panel: HTMLElement, desc: PanelFocus | null): void {
  if (!desc) return;
  const el = panel.querySelector<HTMLElement>(desc.sel);
  if (!el) return;
  el.focus();
  if (desc.start != null && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    try {
      el.setSelectionRange(desc.start, desc.end ?? desc.start);
    } catch {
      /* number/range inputs forbid setSelectionRange */
    }
  }
}

/** Re-render just the content panel (nav/footer stay). Keyboard focus is
 *  preserved across the rebuild: a pending focus selector wins,
 *  otherwise the previously-focused control is re-found and re-focused. */
function renderPanel(): void {
  const panel = box.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  const captured = capturePanelFocus(panel);
  panel.innerHTML = "";
  // A search with no matches empties the panel too — otherwise the nav says
  // "No matches" while the previously-active category keeps rendering.
  if (visibleCategories().length === 0) return;
  const cat = CATEGORIES.find((c) => c.id === activeCat());
  if (!cat) return;
  const restore = () => {
    const pending = takePendingFocusSelector();
    restorePanelFocus(panel, pending ? { sel: pending, start: null, end: null } : captured);
  };

  const heading = document.createElement("div");
  heading.className = "settings-panel-heading";
  heading.textContent = cat.label;
  panel.appendChild(heading);

  if (cat.note) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = cat.note;
    panel.appendChild(note);
  }

  if ("custom" in cat) {
    if (cat.custom === "sections") renderSections(panel);
    else if (cat.custom === "features") renderFeatures(panel);
    else renderTheme(panel);
    restore();
    return;
  }

  for (const field of cat.fields) {
    const row = document.createElement("div");
    row.className = "settings-field";
    if (field.enabledBy && getPath(working, field.enabledBy) !== true) {
      row.classList.add("disabled");
    }
    const head = document.createElement("div");
    head.className = "settings-field-head";
    const label = document.createElement("label");
    label.className = "settings-field-label";
    label.htmlFor = fieldId(field.path);
    label.textContent = field.label;
    head.appendChild(label);
    if (field.desc) {
      const desc = document.createElement("div");
      desc.className = "settings-field-desc";
      desc.textContent = field.desc;
      head.appendChild(desc);
    }
    const control = makeControl(field);
    row.append(head, control);
    panel.appendChild(row);
  }
  restore();
}

/** The working config as it would be persisted, with section drafts encoded. */
function snapshotForSave(): Config {
  return { ...working, sections: encodeSections(sectionDrafts) };
}

/** Whether the pane holds edits that have not been saved. */
function isDirty(): boolean {
  return JSON.stringify(snapshotForSave()) !== originalJson;
}

async function saveSettings(): Promise<void> {
  // Flush a focused field's pending blur-normalization first: Cmd/Ctrl+Enter can
  // fire while a number input still holds focus and an out-of-range value.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const snapshot = snapshotForSave();
  const btn = saveBtn;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }
  try {
    const restartRequired = await invoke<boolean>("save_config", { config: snapshot });
    originalJson = JSON.stringify(snapshot);
    closeSettings();
    toast(
      restartRequired
        ? "Settings saved. Some changes take effect after restarting the app."
        : "Settings saved.",
    );
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save";
    }
    toast("Couldn't save settings.", "error", String(e));
  }
}

export async function openSettings(): Promise<void> {
  let config: Config;
  try {
    config = await invoke<Config>("get_config");
  } catch (e) {
    toast(`failed to load config: ${e}`, "error");
    return;
  }
  replaceWorking(structuredClone(config));
  replaceSectionDrafts(decodeSections(working.sections));
  setActiveCat(CATEGORIES[0].id);
  setSearchQuery("");
  originalJson = JSON.stringify(snapshotForSave());
  render();
  openOverlay();
}

/** Close the pane, but guard unsaved edits behind a discard confirmation. */
async function requestClose(): Promise<void> {
  if (isDirty()) {
    const discard = await confirmDialog("Discard unsaved changes?", "Discard");
    if (!discard) return;
  }
  closeSettings();
}

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) void requestClose();
});
box.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter saves from anywhere in the pane.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void saveSettings();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen()) void requestClose();
});

// Let the controls and the sections editor ask for a panel rebuild.
registerPanelRedraw(renderPanel);
