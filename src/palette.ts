// Fuzzy command/session palette (Cmd/Ctrl+K). Sessions attach on Enter;
// commands run their action. Subsequence match with a simple score:
// earlier + contiguous matches rank higher.

import { noTextAssist } from "./dom";

export type PaletteEntry = {
  label: string;
  hint: string;
  action: () => void;
  /** Which section the entry renders under. Defaults to "command" so command
   *  providers need no change; the session provider marks its entries. */
  kind?: "session" | "command";
  /** Command-only: formatted shortcut glyphs (e.g. "⌘E"), shown right-aligned. */
  shortcut?: string;
  /** Command-only: leading action glyph and its tint (a status-chip tone name,
   *  e.g. "success"). Untinted ⌥ when omitted. */
  icon?: string;
  iconTone?: string;
  /** Session-only: project-identity class (proj-N), the project name, and the
   *  state pill's word + tone (shared status-chip vocabulary). */
  projClass?: string;
  project?: string;
  state?: string;
  stateTone?: string;
};

let providers: (() => PaletteEntry[])[] = [];

export function registerPaletteProvider(p: () => PaletteEntry[]): void {
  providers.push(p);
}

export function score(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let s = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      s += 10 + streak * 5 - ti; // contiguous + early bonus
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? s : null;
}

const overlay = document.createElement("div");
overlay.id = "palette";
overlay.classList.add("hidden");
overlay.setAttribute("role", "dialog");
overlay.setAttribute("aria-modal", "true");
overlay.setAttribute("aria-label", "Command palette");
const box = document.createElement("div");
box.className = "palette-box";
const header = document.createElement("div");
header.className = "palette-header";
const kbd = document.createElement("span");
kbd.className = "palette-kbd";
kbd.textContent = "⌘";
kbd.setAttribute("aria-hidden", "true");
const input = noTextAssist(document.createElement("input"));
input.placeholder = "Jump to session or run a command…";
input.setAttribute("role", "combobox");
input.setAttribute("aria-label", "Jump to session or run a command");
input.setAttribute("aria-autocomplete", "list");
input.setAttribute("aria-expanded", "true");
input.setAttribute("aria-controls", "palette-list");
const esc = document.createElement("span");
esc.className = "palette-esc";
esc.textContent = "esc";
esc.setAttribute("aria-hidden", "true");
header.append(kbd, input, esc);
const list = document.createElement("div");
list.className = "palette-list";
list.id = "palette-list";
list.setAttribute("role", "listbox");
list.setAttribute("aria-label", "Sessions and commands");
box.append(header, list);
overlay.appendChild(box);
document.body.appendChild(overlay);

let entries: PaletteEntry[] = [];
let filtered: PaletteEntry[] = [];
let selected = 0;
// The element focused when the palette opened, restored on close so keyboard
// users land back where they were instead of on document.body.
let lastFocused: HTMLElement | null = null;

function openPalette(): void {
  lastFocused = document.activeElement as HTMLElement | null;
  entries = providers.flatMap((p) => p());
  input.value = "";
  selected = 0;
  overlay.classList.remove("hidden");
  refilter();
  setTimeout(() => input.focus(), 0);
}

function closePalette(): void {
  overlay.classList.add("hidden");
  const restore = lastFocused;
  lastFocused = null;
  if (restore && document.contains(restore)) restore.focus();
}

export function togglePalette(): void {
  if (overlay.classList.contains("hidden")) openPalette();
  else closePalette();
}

/** Sessions render in their own section above Commands, so group them ahead of
 *  commands while preserving the per-kind order (provider order or score). */
function kindRank(e: PaletteEntry): number {
  return e.kind === "session" ? 0 : 1;
}

// The command provider tags shortcut-only commands with a filler hint; it is
// neither shown nor searched, so only real descriptions and session metadata
// (branch/group) contribute to matching.
const FILLER_HINT = "command";
function displayHint(e: PaletteEntry): string {
  return e.hint === FILLER_HINT ? "" : e.hint;
}
function searchText(e: PaletteEntry): string {
  const hint = displayHint(e);
  return hint ? `${e.label} ${hint}` : e.label;
}

function refilter(): void {
  const q = input.value.trim();
  let ranked: PaletteEntry[];
  if (!q) {
    // Empty query: show every command, plus a capped slice of sessions, so a
    // large fleet never pushes the command list out of reach (a global
    // slice(0,30) hid all commands once 30+ sessions were open).
    const sessions = entries.filter((e) => e.kind === "session");
    const commands = entries.filter((e) => e.kind !== "session");
    ranked = [...sessions.slice(0, 30), ...commands];
  } else {
    ranked = entries
      .map((e) => ({ e, s: score(q, searchText(e)) }))
      .filter((x): x is { e: PaletteEntry; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.e);
  }
  // Stable group-by-kind: sessions first, commands after, order within each
  // kind preserved (Array.sort is stable on V8).
  filtered = ranked.slice().sort((a, b) => kindRank(a) - kindRank(b));
  selected = Math.min(selected, Math.max(0, filtered.length - 1));
  renderList();
}

function groupLabel(kind: PaletteEntry["kind"]): string {
  return kind === "session" ? "Sessions" : "Commands";
}

function renderList(): void {
  list.innerHTML = "";
  input.removeAttribute("aria-activedescendant");
  if (filtered.length === 0) {
    // No-results is a state, not a blank void — name it so the user knows the
    // search ran and matched nothing (vs. the palette failing to load).
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "No matching sessions or commands";
    list.appendChild(empty);
    return;
  }
  let lastKind: PaletteEntry["kind"] | null = null;
  filtered.forEach((e, i) => {
    const kind = e.kind ?? "command";
    if (kind !== lastKind) {
      const group = document.createElement("div");
      group.className = "palette-group";
      group.setAttribute("role", "presentation");
      group.textContent = groupLabel(kind);
      list.appendChild(group);
      lastKind = kind;
    }
    const row = document.createElement("div");
    row.className = "palette-row";
    row.id = `palette-option-${i}`;
    row.setAttribute("role", "option");
    const isSelected = i === selected;
    row.classList.toggle("selected", isSelected);
    row.setAttribute("aria-selected", isSelected ? "true" : "false");
    // Label stays the first <span> child (test/page-object contract).
    const label = document.createElement("span");
    label.className = "palette-label";
    label.textContent = e.label;
    if (kind === "session") {
      // Non-<span> so the label stays the row's first <span> (test contract).
      const square = document.createElement("i");
      square.className = `palette-proj proj-square ${e.projClass ?? ""}`.trim();
      const project = document.createElement("span");
      project.className = "palette-meta";
      project.textContent = e.project ?? "";
      // Labeled state pill in the shared status-chip vocabulary.
      const state = document.createElement("span");
      state.className = `palette-state status-chip compact tone-${e.stateTone ?? "dim"}`;
      const stateLabel = document.createElement("span");
      stateLabel.className = "chip-label";
      stateLabel.textContent = e.state ?? "";
      state.appendChild(stateLabel);
      row.append(square, label, project, state);
    } else {
      // Non-<span> so the label stays the row's first <span> (test contract).
      const icon = document.createElement("i");
      icon.className = `palette-icon${e.iconTone ? ` tone-${e.iconTone}` : ""}`;
      icon.textContent = e.icon ?? "⌥";
      row.append(icon, label);
      // A shortcut glyph replaces the generic hint text on the right; otherwise
      // the hint (e.g. a description like "force dark") fills the slot.
      if (e.shortcut) {
        const kbd = document.createElement("span");
        kbd.className = "palette-shortcut";
        kbd.textContent = e.shortcut;
        row.appendChild(kbd);
      } else {
        // Only a real description fills the right slot; the "command" filler
        // hint leaves the row clean.
        const text = displayHint(e);
        if (text) {
          const hint = document.createElement("span");
          hint.className = "palette-hint";
          hint.textContent = text;
          row.appendChild(hint);
        }
      }
    }
    row.addEventListener("click", () => {
      closePalette();
      e.action();
    });
    list.appendChild(row);
  });
  const selectedRow = list.querySelector<HTMLElement>(".palette-row.selected");
  if (selectedRow) {
    input.setAttribute("aria-activedescendant", selectedRow.id);
    // Keep arrow-key selection visible past the fold instead of scrolling off
    // the bottom of the list.
    selectedRow.scrollIntoView({ block: "nearest" });
  }
}

input.addEventListener("input", () => {
  selected = 0;
  refilter();
});
input.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Tab") {
    // The input is the only focusable element in the palette; trap Tab so
    // focus can't escape to the page behind the modal.
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") closePalette();
  if (e.key === "ArrowDown") {
    selected = Math.min(selected + 1, filtered.length - 1);
    renderList();
  }
  if (e.key === "ArrowUp") {
    selected = Math.max(selected - 1, 0);
    renderList();
  }
  if (e.key === "Enter" && filtered[selected]) {
    closePalette();
    filtered[selected].action();
  }
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closePalette();
});
// Escape at the overlay level as well as on the input, so the palette still
// closes if focus ever lands outside the field.
overlay.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    closePalette();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    if (overlay.classList.contains("hidden")) openPalette();
    else closePalette();
  }
});
