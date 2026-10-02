// GUI-owned theming: the custom-theme registry, the preferences that pick a
// theme, and applying one to the page.
//
// Deliberately independent of claude-commander's config — prefs live in
// localStorage, not the shared Config (settings.ts) — and deliberately free of
// Tauri imports, because vite.config.ts imports the built-in registry to
// generate the no-flash boot script.
//
// Two layers of preference: the global theme (a mode plus a preferred light
// and dark theme), and an optional per-workspace override, one palette per
// workspace whatever the mode. resolveTheme() consults the active workspace's
// override first, so switching workspaces re-skins everything that listens
// through onThemeChange (chrome, xterm, Shiki).
//
// The palettes themselves are in ./palettes; ./validate turns a user's theme
// file into one. Both are re-exported here so `./theme` stays the one import.

import type { Appearance, Mode, Theme } from "./types";
import { LATTE, MOCHA, THEMES } from "./palettes";
import {
  activeWorkspace,
  onWorkspaceChange,
  registerWorkspaceState,
  workspaceKey,
  type WorkspaceKeyedState,
} from "../app/workspaces";

export type { Appearance, Mode, Theme } from "./types";
export { THEMES } from "./palettes";
export { validateTheme, type ValidationResult } from "./validate";

// --------------------------------------------------- custom theme registry

// User-authored themes, registered at runtime from disk (see main.ts). Kept
// separate from THEMES so the built-in seed stays a static, build-time-safe
// export; lookups consult the merged view.
let customThemes: Record<string, Theme> = {};

function mergedThemes(): Record<string, Theme> {
  return { ...THEMES, ...customThemes };
}

/** Replace the custom theme set (validated upstream). Built-ins are untouched. */
export function registerCustomThemes(themes: Theme[]): void {
  customThemes = Object.fromEntries(themes.map((t) => [t.id, t]));
}

/** All selectable themes — built-ins first, then custom — for the picker. */
export function allThemes(): Theme[] {
  return Object.values(mergedThemes());
}

// localStorage keys — GUI-local, intentionally not in commander config.
const KEY_MODE = "cc-theme-mode";
const KEY_LIGHT = "cc-theme-light";
const KEY_DARK = "cc-theme-dark";

const DEFAULT_MODE: Mode = "system";

export function getMode(): Mode {
  const v = localStorage.getItem(KEY_MODE);
  return v === "light" || v === "dark" || v === "system" ? v : DEFAULT_MODE;
}

function getLightTheme(): Theme {
  return mergedThemes()[localStorage.getItem(KEY_LIGHT) ?? ""] ?? LATTE;
}

function getDarkTheme(): Theme {
  return mergedThemes()[localStorage.getItem(KEY_DARK) ?? ""] ?? MOCHA;
}

/** The theme currently filling the preferred slot for an appearance (what the
 *  picker marks "current" and starts on). */
export function preferredTheme(appearance: Appearance): Theme {
  return appearance === "dark" ? getDarkTheme() : getLightTheme();
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The global theme: what the prefs + OS appearance pick, ignoring any
 *  workspace override. What the theme picker edits. */
export function resolveGlobalTheme(): Theme {
  const mode = getMode();
  const dark = mode === "system" ? systemPrefersDark() : mode === "dark";
  return dark ? getDarkTheme() : getLightTheme();
}

/** The theme that should be active: the active workspace's override when it
 *  has one, else the global theme. */
export function resolveTheme(): Theme {
  return workspaceOverride() ?? resolveGlobalTheme();
}

// ------------------------------------------------- per-workspace overrides

// `cc-workspace-themes`: workspaceKey(name) -> theme id. No entry = "Global
// theme" (inherit). An id that isn't registered (a custom theme whose file was
// removed, or not loaded yet at boot) resolves as no override, but the entry
// is kept, so the theme comes back if its file does.
const KEY_WORKSPACE_THEMES = "cc-workspace-themes";

function readOverrides(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY_WORKSPACE_THEMES) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

let overrides: Record<string, string> = readOverrides();

function writeOverrides(next: Record<string, string>): void {
  overrides = next;
  try {
    localStorage.setItem(KEY_WORKSPACE_THEMES, JSON.stringify(overrides));
  } catch {
    // best effort: the override still holds for this run
  }
}

/** The theme id workspace `name` (null = Main) is set to, or null for
 *  "Global theme". May name a theme that isn't registered. */
export function workspaceThemeId(name: string | null): string | null {
  return overrides[workspaceKey(name)] ?? null;
}

/** The active workspace's override, if it has one that resolves. */
export function workspaceOverride(): Theme | null {
  const id = workspaceThemeId(activeWorkspace());
  return id === null ? null : (mergedThemes()[id] ?? null);
}

/** Set workspace `name`'s theme (null = inherit the global theme), and
 *  re-skin now if it's the one on screen. */
export function setWorkspaceTheme(name: string | null, themeId: string | null): void {
  const key = workspaceKey(name);
  const next = { ...overrides };
  if (themeId === null) delete next[key];
  else next[key] = themeId;
  writeOverrides(next);
  if (name === activeWorkspace()) reapplyTheme();
}

/** The override map, as a store that follows workspace renames and deletes
 *  (core's maintain only the TUI's `[workspace_themes]`). */
export const workspaceThemeState: WorkspaceKeyedState = {
  keys: () => Object.keys(overrides),
  move(from, to) {
    if (!(from in overrides)) return;
    const next = { ...overrides, [to]: overrides[from] };
    delete next[from];
    writeOverrides(next);
  },
  drop(key) {
    if (!(key in overrides)) return;
    const next = { ...overrides };
    delete next[key];
    writeOverrides(next);
  },
};

/** Apply the resolved theme. When it's the one on screen already, only the
 *  boot cache is brought up to date (it may now be the override, or no longer
 *  be), so the listeners don't redraw for nothing. */
function reapplyTheme(): void {
  const next = resolveTheme();
  if (next.id !== active?.id) applyTheme(next);
  else cacheForBoot(next);
}

let active: Theme | null = null;

export function currentTheme(): Theme {
  return active ?? resolveTheme();
}

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

/** Subscribe to theme changes (Phase 3/4 wire terminal + Shiki here). */
export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// Cache key for the global theme's resolved cssVars, per appearance. The
// pre-paint boot script (vite.config.ts) replays this before first paint so a
// custom theme — unknown at build time — doesn't flash the built-in defaults.
const KEY_VARS = (a: Appearance) => `cc-theme-vars-${a}`;

/** Cache key for the workspace override on screen, `{ appearance, cssVars }`,
 *  present only while one is. The boot script prefers it over the per-
 *  appearance cache, so relaunching into the same workspace paints its theme
 *  whatever the OS appearance. Exported for the boot script, so the key can't
 *  drift. */
export const KEY_OVERRIDE_VARS = "cc-theme-vars-workspace";

function applyVars(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.cssVars)) {
    root.style.setProperty(`--${k}`, v);
  }
  root.dataset.appearance = theme.appearance;
  active = theme;
  for (const cb of listeners) cb(theme);
}

/** Apply a theme (CSS vars + xterm/Shiki via listeners) and cache what the
 *  no-flash boot replays: the global theme's vars always, and the override's
 *  while `theme` is the active workspace's override. */
export function applyTheme(theme: Theme): void {
  applyVars(theme);
  cacheForBoot(theme);
}

function cacheForBoot(theme: Theme): void {
  const override = workspaceOverride();
  const isOverride = override !== null && override.id === theme.id;
  const global = isOverride ? resolveGlobalTheme() : theme;
  try {
    localStorage.setItem(KEY_VARS(global.appearance), JSON.stringify(global.cssVars));
    if (isOverride) {
      localStorage.setItem(
        KEY_OVERRIDE_VARS,
        JSON.stringify({ appearance: theme.appearance, cssVars: theme.cssVars }),
      );
    } else {
      localStorage.removeItem(KEY_OVERRIDE_VARS);
    }
  } catch {
    // storage full or unavailable: only the boot replay is affected
  }
}

/** Apply a theme transiently for previewing — no cache write, no pref change.
 *  Revert with `applyTheme(resolveTheme())` to fall back to the saved selection. */
export function previewTheme(theme: Theme): void {
  applyVars(theme);
}

export function setMode(mode: Mode): void {
  localStorage.setItem(KEY_MODE, mode);
  applyTheme(resolveTheme());
}

/**
 * Pick a specific theme: record it as the preferred theme for its appearance and
 * switch to that appearance now. System mode (followSystem) later reuses these
 * preferred-light/-dark slots, so the choice persists across OS-appearance flips.
 */
export function chooseTheme(theme: Theme): void {
  localStorage.setItem(theme.appearance === "dark" ? KEY_DARK : KEY_LIGHT, theme.id);
  setMode(theme.appearance);
}

/** Re-resolve and apply, but only while following the OS (mode === "system"). */
export function followSystem(): void {
  // Under a workspace override the flip changes nothing on screen, only the
  // global theme the boot cache holds.
  if (getMode() === "system") reapplyTheme();
}

/** Initialize from stored prefs + current OS appearance. Call once at boot. */
export function initTheme(): void {
  wireWorkspaceThemes();
  applyTheme(resolveTheme());
  // matchMedia is the reliable appearance signal inside WKWebView; the native
  // Tauri theme event (wired in main.ts) is the cross-platform primary.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", followSystem);
}

/** Have the overrides follow workspace renames and deletes, and re-resolve on
 *  every workspace change (a switch, the startup choice, falling back to Main
 *  when one vanishes; a rename resolves the same theme, so draws nothing). Part
 *  of initTheme; exported for tests, which reset the workspace module. */
export function wireWorkspaceThemes(): void {
  registerWorkspaceState(workspaceThemeState);
  onWorkspaceChange(() => reapplyTheme());
}

/** Reset the override map, re-reading localStorage. Tests only. */
export function resetWorkspaceThemesForTest(): void {
  overrides = readOverrides();
  active = null;
}
