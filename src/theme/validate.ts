// Validating a user-authored theme file into a `Theme`.
//
// Pure — no Tauri, no DOM — so it stays Node-importable (the unit tests call it
// directly). Anything a theme file leaves out is inherited from a built-in, so a
// three-line file is a valid theme.

import type { ITheme } from "@xterm/xterm";
import type { ThemeRegistration } from "@pierre/diffs";
import type { Appearance, Theme } from "./types";
import { MOCHA, THEMES } from "./palettes";


/** The 21 per-theme color tokens; the source of truth is the built-in shape. */
const VAR_KEYS = Object.keys(MOCHA.cssVars);
/** Bundled Shiki ids we can actually load (only Catppuccin ships in the bundle). */
const SHIKI_IDS = new Set(
  Object.values(THEMES).flatMap((t) => (typeof t.shiki === "string" ? [t.shiki] : [])),
);
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

function builtinFor(appearance: Appearance): Theme {
  return Object.values(THEMES).find((t) => t.appearance === appearance)!;
}

export type ValidationResult = { theme: Theme } | { error: string };

/**
 * Validate + normalize a parsed theme file into a `Theme`. Unset cssVars/terminal
 * entries inherit from a base built-in (the `base` field, or the one matching
 * `appearance`); individual bad-hex overrides are dropped (fall back to inherited)
 * rather than failing the whole theme. Only structural problems — missing
 * id/label/appearance, or an id colliding with a built-in — reject the theme.
 * Pure: no Tauri, no DOM, so it stays Node-importable alongside the rest of the file.
 */
export function validateTheme(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) return { error: "not an object" };
  const r = raw as Record<string, unknown>;

  const id = r.id;
  if (typeof id !== "string" || !id.trim()) return { error: 'missing or invalid "id"' };
  if (id in THEMES) return { error: `id "${id}" collides with a built-in theme` };

  if (typeof r.label !== "string" || !r.label.trim())
    return { error: `theme "${id}": missing "label"` };
  const label = r.label;

  if (r.appearance !== "light" && r.appearance !== "dark")
    return { error: `theme "${id}": "appearance" must be "light" or "dark"` };
  const appearance = r.appearance;

  const base =
    typeof r.base === "string" && r.base in THEMES ? THEMES[r.base] : builtinFor(appearance);

  // cssVars: clone the base, override known keys that carry a valid hex value.
  const cssVars = { ...base.cssVars };
  const rawVars = (r.cssVars ?? {}) as Record<string, unknown>;
  for (const key of VAR_KEYS) {
    if (isHex(rawVars[key])) cssVars[key] = rawVars[key] as string;
  }

  // terminal: clone the base, override any entry that carries a valid hex value.
  const terminal: ITheme = { ...base.terminal };
  for (const [key, value] of Object.entries((r.terminal ?? {}) as Record<string, unknown>)) {
    if (isHex(value)) (terminal as Record<string, string>)[key] = value;
  }

  // shiki: a supplied object wins (name forced to the theme id so review.ts can
  // key on it); a *bundled* id string is honoured; anything else (absent, or a
  // non-bundled id we can't load) inherits the base built-in's id.
  let shiki: Theme["shiki"];
  if (typeof r.shiki === "object" && r.shiki !== null) {
    shiki = { ...(r.shiki as ThemeRegistration), name: id };
  } else if (typeof r.shiki === "string" && SHIKI_IDS.has(r.shiki)) {
    shiki = r.shiki;
  } else {
    shiki = base.shiki;
  }

  return {
    theme: { id, label, appearance, source: "custom", base: base.id, cssVars, terminal, shiki },
  };
}
