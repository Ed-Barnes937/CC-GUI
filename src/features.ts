// Optional-feature registry: the seam for GUI features that not every user
// wants switched on (see docs/adr/0008-optional-feature-registry.md).
//
// A feature contributes command-palette entries and keybinding actions, and
// gets a toggle in Settings → Features. Both contributions are read from the
// registry at the moment they're needed — the palette asks each time it opens,
// and the keybinding table is rebuilt when a toggle flips — so enabling or
// disabling a feature takes effect immediately, with no restart.
//
// Enabled state is GUI-owned: it lives in localStorage next to the theme
// preferences and never touches the claude-commander config.

import type { PaletteEntry } from "./palette";

/** A keybinding action, in the same shape as main.ts's KEY_ACTIONS table so the
 *  two merge directly and the help overlay picks up the label for free. */
export type FeatureAction = { label: string; run: () => void };

export type Feature = {
  /** Stable id — the localStorage key and the settings row's DOM id. */
  id: string;
  /** Name shown in Settings. */
  name: string;
  /** One line in Settings explaining what enabling it does. */
  desc: string;
  /** Whether it's on for a user who has never touched the toggle. */
  defaultEnabled: boolean;
  /** Palette entries to offer while enabled. Called each time the palette opens. */
  palette?: () => PaletteEntry[];
  /** Keybinding actions to bind while enabled, keyed by config action name. */
  actions?: Record<string, FeatureAction>;
};

const STORE_KEY = "cc-features";

const registry: Feature[] = [];
const listeners: (() => void)[] = [];

/** Explicit user choices only — a feature absent here uses its `defaultEnabled`,
 *  so changing a default later moves users who never expressed a preference. */
function overrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "boolean"),
    ) as Record<string, boolean>;
  } catch {
    return {}; // unreadable or corrupt: fall back to every default
  }
}

/** Register a feature. Later registrations of the same id replace the earlier
 *  one, which keeps module re-evaluation in tests from stacking duplicates. */
export function registerFeature(f: Feature): void {
  const at = registry.findIndex((r) => r.id === f.id);
  if (at >= 0) registry[at] = f;
  else registry.push(f);
}

/** Every registered feature, in registration order. */
export function allFeatures(): readonly Feature[] {
  return registry;
}

export function isEnabled(id: string): boolean {
  const f = registry.find((r) => r.id === id);
  if (!f) return false; // an unknown id contributes nothing
  return overrides()[id] ?? f.defaultEnabled;
}

/** Persist a choice and notify listeners. A no-op change stays silent so
 *  callers can re-assert the current value without churning the keybindings. */
export function setEnabled(id: string, on: boolean): void {
  if (!registry.some((r) => r.id === id)) return;
  if (isEnabled(id) === on) return;
  const next = { ...overrides(), [id]: on };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    return; // storage unavailable (private mode): leave the toggle where it was
  }
  for (const cb of listeners) cb();
}

/** Subscribe to enablement changes — main.ts rebinds keys on each one. */
export function onFeatureChange(cb: () => void): void {
  listeners.push(cb);
}

/** Palette entries from every enabled feature. */
export function featurePalette(): PaletteEntry[] {
  return registry
    .filter((f) => f.palette && isEnabled(f.id))
    .flatMap((f) => f.palette!());
}

/** Keybinding actions from every enabled feature. A disabled feature's actions
 *  are absent rather than inert, so the help overlay doesn't advertise keys
 *  that would do nothing. */
export function featureActions(): Record<string, FeatureAction> {
  const out: Record<string, FeatureAction> = {};
  for (const f of registry) {
    if (!isEnabled(f.id)) continue;
    Object.assign(out, f.actions ?? {});
  }
  return out;
}

/** Test seam: drop every registration and stored choice. */
export function resetFeaturesForTest(): void {
  registry.length = 0;
  listeners.length = 0;
  localStorage.removeItem(STORE_KEY);
}
