// Keybindings driven by the claude-commander config: the backend serves the
// `[keybindings]` table ("Ctrl-"/"Alt-"/"Shift-" prefixes + key name, the
// TUI's format) and we dispatch the actions the GUI supports.

import { invoke } from "@tauri-apps/api/core";

export type ParsedBinding = {
  ctrl: boolean;
  alt: boolean;
  /** null for single-char keys: the char itself encodes shift ("N", "?"). */
  shift: boolean | null;
  /** KeyboardEvent.key value to match. */
  key: string;
};

/** Crossterm key names → KeyboardEvent.key values. */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  esc: "Escape",
  tab: "Tab",
  backtab: "Tab", // browser reports Shift+Tab as Tab+shiftKey
  backspace: "Backspace",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  delete: "Delete",
  insert: "Insert",
};

export function parseBinding(s: string): ParsedBinding | null {
  let rest = s.trim();
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (;;) {
    const lower = rest.toLowerCase();
    if (lower.startsWith("ctrl-")) {
      ctrl = true;
      rest = rest.slice(5);
    } else if (lower.startsWith("alt-")) {
      alt = true;
      rest = rest.slice(4);
    } else if (lower.startsWith("shift-")) {
      shift = true;
      rest = rest.slice(6);
    } else {
      break;
    }
  }
  const lower = rest.toLowerCase();
  if (lower in NAMED_KEYS) {
    return { ctrl, alt, shift: shift || lower === "backtab", key: NAMED_KEYS[lower] };
  }
  if (/^f\d{1,2}$/.test(lower)) {
    return { ctrl, alt, shift, key: `F${lower.slice(1)}` };
  }
  if ([...rest].length === 1) {
    // Single char: e.key already reflects shift ("N", "?"), so don't also
    // require the modifier bit the TUI stores alongside it.
    return { ctrl, alt, shift: null, key: rest };
  }
  return null;
}

export function matches(b: ParsedBinding, e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey !== b.ctrl || e.altKey !== b.alt) return false;
  if (b.shift !== null && e.shiftKey !== b.shift) return false;
  return e.key === b.key;
}

/** KeyboardEvent.key values → display glyphs for the named keys we parse. */
const KEY_GLYPHS: Record<string, string> = {
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  " ": "␣",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Delete: "⌦",
  Insert: "Ins",
};

/**
 * Render a config binding string ("Ctrl-Enter") as symbols ("⌃↵") for menus and
 * the palette. Modifier order ⌃⌥⇧; single-char keys already carry Shift in their
 * glyph (dispatch ignores the Shift bit for them), so ⇧ is only shown for named
 * keys. Returns null when the string doesn't parse.
 */
export function formatBinding(s: string): string | null {
  const b = parseBinding(s);
  if (!b) return null;
  let out = "";
  if (b.ctrl) out += "⌃";
  if (b.alt) out += "⌥";
  if (b.shift === true) out += "⇧";
  out += KEY_GLYPHS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return out;
}

/** Raw action → key-strings table, for the help overlay. */
export let loadedBindings: Record<string, string[]> = {};

/** True when the event target is somewhere that owns its own keyboard. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // A button/link keeps focus after a click; without this, Enter (=select)
  // would fire both the button's native activation and the keybinding, and a
  // bare letter would trigger its action against the focused control.
  if (tag === "BUTTON" || tag === "A" || t.closest("button")) return true;
  return t.closest(".xterm") !== null;
}

export function overlayOpen(): boolean {
  return (
    document.querySelector("#palette:not(.hidden)") !== null ||
    document.querySelector("#help-overlay:not(.hidden)") !== null ||
    document.querySelector("#settings-overlay:not(.hidden)") !== null ||
    document.querySelector("#review:not(.hidden)") !== null ||
    document.querySelector("#file-explorer:not(.hidden)") !== null ||
    document.querySelector(".confirm-overlay") !== null ||
    document.querySelector(".context-menu") !== null
  );
}

const table: { binding: ParsedBinding; handler: () => void }[] = [];
let boundActions: Record<string, () => void> = {};
let listenerInstalled = false;

/** Fetch the config's keybinding table and rebuild the dispatch table. */
async function loadTable(): Promise<boolean> {
  let raw: Record<string, string[]>;
  try {
    raw = await invoke<Record<string, string[]>>("get_keybindings");
  } catch {
    return false; // no keybinds; everything stays mouse-reachable
  }
  loadedBindings = raw;
  buildTable();
  return true;
}

/** Rebuild the dispatch table by pairing the loaded bindings with the currently
 *  bound actions. Bindings whose action isn't bound are simply left out. */
function buildTable(): void {
  table.length = 0;
  for (const [action, keys] of Object.entries(loadedBindings)) {
    const handler = boundActions[action];
    if (!handler) continue;
    for (const k of keys) {
      const binding = parseBinding(k);
      if (binding) table.push({ binding, handler });
    }
  }
}

/**
 * Fetch the config's keybindings and dispatch the actions in `actions`.
 * Actions the GUI doesn't support are simply not registered. Returns whether
 * the table loaded (callers may install fallbacks when it didn't).
 */
export async function initKeybindings(actions: Record<string, () => void>): Promise<boolean> {
  boundActions = actions;
  if (!(await loadTable())) return false;

  listenerInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (isTyping(e) || overlayOpen()) return;
    for (const { binding, handler } of table) {
      if (matches(binding, e)) {
        e.preventDefault();
        handler();
        return;
      }
    }
  });
  return true;
}

/**
 * Swap the bound action set and rebuild the dispatch table from the bindings
 * already loaded — used when an optional feature is toggled on or off, which
 * changes which actions exist without changing the config. No-op before the
 * initial load succeeded, since the dispatch listener was never installed.
 */
export function rebindActions(actions: Record<string, () => void>): void {
  boundActions = actions;
  if (!listenerInstalled) return;
  buildTable();
}

/**
 * Re-fetch the keybinding table after an external config change (the backend
 * emits `config-updated` when config.toml is hot-reloaded). No-op when the
 * initial load failed: the dispatch listener was never installed and main.ts
 * runs its own fallback instead.
 */
export async function reloadKeybindings(): Promise<boolean> {
  if (!listenerInstalled) return false;
  return loadTable();
}

/** The first bound chord for an action, formatted for a menu hint. */
export function kb(action: string): string | undefined {
  const first = (loadedBindings[action] ?? [])[0];
  return (first && formatBinding(first)) || undefined;
}
