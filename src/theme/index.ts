// GUI-owned theming: the custom-theme registry, the preferences that pick a
// theme, and applying one to the page.
//
// Deliberately independent of claude-commander's config — prefs live in
// localStorage, not the shared Config (settings.ts) — and deliberately free of
// Tauri imports, because vite.config.ts imports the built-in registry to
// generate the no-flash boot script.
//
// The palettes themselves are in ./palettes; ./validate turns a user's theme
// file into one. Both are re-exported here so `./theme` stays the one import.

import type { Appearance, Mode, Theme } from "./types";
import { LATTE, MOCHA, THEMES } from "./palettes";

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

/** The theme that should be active given the current prefs + OS appearance. */
export function resolveTheme(): Theme {
  const mode = getMode();
  const dark = mode === "system" ? systemPrefersDark() : mode === "dark";
  return dark ? getDarkTheme() : getLightTheme();
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

// Cache key for the active theme's resolved cssVars, per appearance. The
// pre-paint boot script (vite.config.ts) replays this before first paint so a
// custom theme — unknown at build time — doesn't flash the built-in defaults.
const KEY_VARS = (a: Appearance) => `cc-theme-vars-${a}`;

function applyVars(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.cssVars)) {
    root.style.setProperty(`--${k}`, v);
  }
  root.dataset.appearance = theme.appearance;
  active = theme;
  for (const cb of listeners) cb(theme);
}

/** Apply a theme (CSS vars + xterm/Shiki via listeners) and cache its vars for
 *  the no-flash boot replay. */
export function applyTheme(theme: Theme): void {
  applyVars(theme);
  localStorage.setItem(KEY_VARS(theme.appearance), JSON.stringify(theme.cssVars));
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
  if (getMode() === "system") applyTheme(resolveTheme());
}

/** Initialize from stored prefs + current OS appearance. Call once at boot. */
export function initTheme(): void {
  applyTheme(resolveTheme());
  // matchMedia is the reliable appearance signal inside WKWebView; the native
  // Tauri theme event (wired in main.ts) is the cross-platform primary.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", followSystem);
}
