// Loading user-authored themes from disk, and writing a template out.
//
// The GUI owns its theming (./index.ts) and never touches the
// claude-commander config; this is only the file-system half -- reading
// ~/.config/claude-commander/themes and registering what validates.

import { invoke } from "@tauri-apps/api/core";
import { toast, promptDialog } from "../toast";
import {
  applyTheme,
  currentTheme,
  registerCustomThemes,
  resolveTheme,
  validateTheme,
  type Theme,
} from "./index";

// Load user-authored themes from disk, register the valid ones, and re-apply if a
// custom theme now occupies the active light/dark slot. Runs after initTheme() so
// a built-in (or the cached vars from the no-flash boot script) is already on
// screen — this upgrades to the custom theme without blocking first paint.
export async function loadCustomThemes(announce = false): Promise<void> {
  let files: { file: string; content: unknown }[];
  try {
    files = await invoke("list_custom_themes");
  } catch (e) {
    toast(`Failed to load custom themes: ${e}`, "error");
    return;
  }
  const valid: Theme[] = [];
  const errors: string[] = [];
  for (const { file, content } of files) {
    const result = validateTheme(content);
    if ("theme" in result) valid.push(result.theme);
    else errors.push(`${file}: ${result.error}`);
  }
  registerCustomThemes(valid);
  const next = resolveTheme();
  if (next.id !== currentTheme().id) applyTheme(next);
  if (errors.length) {
    toast(`Skipped ${errors.length} invalid theme file(s) — ${errors.join("; ")}`, "error");
  }
  // announce only on an explicit reload — the boot call stays silent.
  if (announce) toast(`Loaded ${valid.length} custom theme(s)`);
}
void loadCustomThemes();

// Write the active theme out as an editable starting template, then register it
// and reveal the folder. The id/label are fresh so the file never collides with
// its source (a built-in's id would be rejected on reload).
export async function exportThemeTemplate(): Promise<void> {
  const name = await promptDialog(
    "Name for the new theme (saved as a .json in the themes folder):",
    "my-theme",
  );
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-theme";
  const t = currentTheme();
  const template = {
    id: slug,
    label: name,
    appearance: t.appearance,
    cssVars: t.cssVars,
    terminal: t.terminal,
    shiki: t.shiki,
  };
  try {
    const path = await invoke<string>("save_custom_theme", { name: slug, theme: template });
    await loadCustomThemes(); // register it now so it's pickable immediately
    toast(`Saved ${path} — edit it, then pick it from the palette`);
    void invoke("open_themes_dir").catch(() => {});
  } catch (e) {
    toast(`Export failed: ${e}`, "error");
  }
}
