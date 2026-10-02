import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  THEMES,
  validateTheme,
  getMode,
  resolveTheme,
  preferredTheme,
  chooseTheme,
  registerCustomThemes,
  allThemes,
  applyTheme,
  currentTheme,
  resolveGlobalTheme,
  setMode,
  setWorkspaceTheme,
  workspaceOverride,
  workspaceThemeId,
  wireWorkspaceThemes,
  resetWorkspaceThemesForTest,
  KEY_OVERRIDE_VARS,
  type Theme,
} from "./index";
import {
  reconcileActiveWorkspace,
  resetWorkspacesForTest,
  setActiveWorkspace,
  workspaceDeleted,
  workspaceRenamed,
} from "../app/workspaces";
import type { WorkspaceEntry } from "../app/types";

const MOCHA = THEMES["catppuccin-mocha"];
const NORD = THEMES["nord"];

/** Unwrap a successful validation or fail loudly. */
function ok(raw: unknown): Theme {
  const r = validateTheme(raw);
  if (!("theme" in r)) throw new Error(`expected valid theme, got error: ${r.error}`);
  return r.theme;
}

describe("validateTheme — rejection", () => {
  it("rejects non-objects", () => {
    expect(validateTheme(null)).toEqual({ error: "not an object" });
    expect(validateTheme(42)).toEqual({ error: "not an object" });
  });

  it("rejects a missing or blank id", () => {
    expect(validateTheme({})).toEqual({ error: 'missing or invalid "id"' });
    expect(validateTheme({ id: "   " })).toEqual({ error: 'missing or invalid "id"' });
  });

  it("rejects an id that collides with a built-in", () => {
    expect(validateTheme({ id: "catppuccin-mocha", label: "x", appearance: "dark" })).toEqual({
      error: 'id "catppuccin-mocha" collides with a built-in theme',
    });
  });

  it("rejects a missing label", () => {
    expect(validateTheme({ id: "my-theme", appearance: "dark" })).toEqual({
      error: 'theme "my-theme": missing "label"',
    });
  });

  it("rejects a bad appearance", () => {
    expect(validateTheme({ id: "my-theme", label: "X", appearance: "neon" })).toEqual({
      error: 'theme "my-theme": "appearance" must be "light" or "dark"',
    });
  });
});

describe("validateTheme — normalization", () => {
  it("inherits the matching built-in for an otherwise-empty theme", () => {
    const t = ok({ id: "my-dark", label: "My Dark", appearance: "dark" });
    expect(t.source).toBe("custom");
    expect(t.base).toBe("catppuccin-mocha"); // first dark built-in
    expect(t.cssVars).toEqual(MOCHA.cssVars);
    expect(t.terminal).toEqual(MOCHA.terminal);
    expect(t.shiki).toBe(MOCHA.shiki);
  });

  it("overrides only valid-hex cssVars and inherits the rest", () => {
    const t = ok({
      id: "my-dark",
      label: "My Dark",
      appearance: "dark",
      cssVars: { accent: "#abcdef", danger: "not-a-color" },
    });
    expect(t.cssVars.accent).toBe("#abcdef");
    expect(t.cssVars.danger).toBe(MOCHA.cssVars.danger); // bad hex dropped → inherited
  });

  it("honours an explicit base built-in", () => {
    const t = ok({ id: "my-dark", label: "My Dark", appearance: "dark", base: "nord" });
    expect(t.base).toBe("nord");
    expect(t.cssVars).toEqual(NORD.cssVars);
  });

  it("overrides valid-hex terminal entries and drops the rest", () => {
    const t = ok({
      id: "my-dark",
      label: "My Dark",
      appearance: "dark",
      terminal: { red: "#000000", bogus: "xx" },
    });
    expect(t.terminal.red).toBe("#000000");
    expect((t.terminal as Record<string, string>).bogus).toBeUndefined();
    expect(t.terminal.blue).toBe(MOCHA.terminal.blue); // untouched → inherited
  });

  it("resolves the shiki field by source", () => {
    // a full object wins, with its name forced to the theme id
    const obj = ok({
      id: "my-dark",
      label: "X",
      appearance: "dark",
      shiki: { name: "ignored", settings: [], tokenColors: [] },
    });
    expect(typeof obj.shiki).toBe("object");
    expect((obj.shiki as { name: string }).name).toBe("my-dark");

    // a bundled id string is honoured
    expect(ok({ id: "a", label: "X", appearance: "dark", shiki: "nord" }).shiki).toBe("nord");

    // a non-bundled id falls back to the base built-in's shiki
    expect(ok({ id: "b", label: "X", appearance: "dark", shiki: "not-bundled" }).shiki).toBe(
      MOCHA.shiki,
    );
  });
});

describe("preferences (localStorage + OS appearance)", () => {
  const stubMatchMedia = (dark: boolean) =>
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: dark,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));

  beforeEach(() => {
    localStorage.clear();
    registerCustomThemes([]); // reset module-level custom registry between tests
    stubMatchMedia(false);
  });

  it("defaults the mode to system", () => {
    expect(getMode()).toBe("system");
    localStorage.setItem("cc-theme-mode", "bogus");
    expect(getMode()).toBe("system");
    localStorage.setItem("cc-theme-mode", "dark");
    expect(getMode()).toBe("dark");
  });

  it("defaults the preferred slots to Mocha / Latte", () => {
    expect(preferredTheme("dark").id).toBe("catppuccin-mocha");
    expect(preferredTheme("light").id).toBe("catppuccin-latte");
  });

  it("resolves by explicit mode regardless of OS", () => {
    stubMatchMedia(true); // OS says dark
    localStorage.setItem("cc-theme-mode", "light");
    expect(resolveTheme().appearance).toBe("light");
    localStorage.setItem("cc-theme-mode", "dark");
    expect(resolveTheme().appearance).toBe("dark");
  });

  it("follows the OS in system mode", () => {
    localStorage.setItem("cc-theme-mode", "system");
    stubMatchMedia(true);
    expect(resolveTheme().appearance).toBe("dark");
    stubMatchMedia(false);
    expect(resolveTheme().appearance).toBe("light");
  });

  it("chooseTheme records the slot and switches to that appearance", () => {
    chooseTheme(NORD);
    expect(getMode()).toBe("dark");
    expect(preferredTheme("dark").id).toBe("nord");
    expect(resolveTheme().id).toBe("nord");

    chooseTheme(THEMES["github-light"]);
    expect(getMode()).toBe("light");
    expect(preferredTheme("light").id).toBe("github-light");
  });

  it("makes registered custom themes selectable and resolvable", () => {
    const custom = ok({ id: "my-dark", label: "My Dark", appearance: "dark" });
    registerCustomThemes([custom]);
    expect(allThemes().some((t) => t.id === "my-dark")).toBe(true);

    chooseTheme(custom);
    expect(resolveTheme().id).toBe("my-dark");
  });
});

describe("per-workspace overrides", () => {
  const TOKYO = THEMES["tokyo-night"];
  const LATTE = THEMES["catppuccin-latte"];
  const list = (...names: string[]): WorkspaceEntry[] => [
    { name: null, label: "Main" },
    ...names.map((name) => ({ name, label: name })),
  ];
  const stored = () => JSON.parse(localStorage.getItem("cc-workspace-themes") ?? "{}");
  const bootOverride = () => JSON.parse(localStorage.getItem(KEY_OVERRIDE_VARS) ?? "null");

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("matchMedia", (media: string) => ({
      matches: false,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    registerCustomThemes([]);
    resetWorkspacesForTest();
    resetWorkspaceThemesForTest();
    wireWorkspaceThemes();
    setMode("dark"); // global = Mocha
  });

  it("inherits the global theme when a workspace has no override", () => {
    setActiveWorkspace("OSS");
    expect(workspaceThemeId("OSS")).toBeNull();
    expect(workspaceOverride()).toBeNull();
    expect(resolveTheme().id).toBe("catppuccin-mocha");
  });

  it("resolves the active workspace's override, whatever the mode", () => {
    setWorkspaceTheme("OSS", "catppuccin-latte");
    expect(resolveTheme().id).toBe("catppuccin-mocha"); // Main is active
    setActiveWorkspace("OSS");
    expect(resolveTheme().id).toBe("catppuccin-latte");
    setMode("light");
    expect(resolveTheme().id).toBe("catppuccin-latte");
    setMode("system");
    expect(resolveTheme().id).toBe("catppuccin-latte");
    // The global theme is still the mode's, for the picker to edit.
    expect(resolveGlobalTheme().id).toBe("catppuccin-latte"); // OS says light
    setMode("dark");
    expect(resolveGlobalTheme().id).toBe("catppuccin-mocha");
  });

  it("Main has its own entry, under the reserved key", () => {
    setWorkspaceTheme(null, "nord");
    expect(stored()).toEqual({ "\u0000main": "nord" });
    expect(resolveTheme().id).toBe("nord");
  });

  it("applies on switch and reverts on switching back", () => {
    setWorkspaceTheme("OSS", "tokyo-night");
    expect(currentTheme().id).toBe("catppuccin-mocha");
    setActiveWorkspace("OSS");
    expect(currentTheme().id).toBe("tokyo-night");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(TOKYO.cssVars.accent);
    setActiveWorkspace(null);
    expect(currentTheme().id).toBe("catppuccin-mocha");
  });

  it("setting the active workspace's theme applies it at once; Global theme reverts", () => {
    setActiveWorkspace("OSS");
    setWorkspaceTheme("OSS", "tokyo-night");
    expect(currentTheme().id).toBe("tokyo-night");
    setWorkspaceTheme("OSS", null);
    expect(currentTheme().id).toBe("catppuccin-mocha");
    expect(stored()).toEqual({});
  });

  it("a theme that isn't registered falls back to the global theme, and comes back with its file", () => {
    const mine = ok({ id: "my-theme", label: "Mine", appearance: "light" });
    registerCustomThemes([mine]);
    setWorkspaceTheme("OSS", "my-theme");
    setActiveWorkspace("OSS");
    expect(resolveTheme().id).toBe("my-theme");

    registerCustomThemes([]); // the file was removed
    expect(resolveTheme().id).toBe("catppuccin-mocha");
    expect(workspaceThemeId("OSS")).toBe("my-theme"); // kept, not dropped

    registerCustomThemes([mine]);
    expect(resolveTheme().id).toBe("my-theme");
  });

  it("follows renames and deletes made here", () => {
    setWorkspaceTheme("OSS", "tokyo-night");
    workspaceRenamed("OSS", "Open source", false);
    expect(stored()).toEqual({ "Open source": "tokyo-night" });
    workspaceDeleted("Open source");
    expect(stored()).toEqual({});
  });

  it("renaming the active workspace keeps its theme on screen", () => {
    setWorkspaceTheme("OSS", "tokyo-night");
    setActiveWorkspace("OSS");
    workspaceRenamed("OSS", "Open source", true);
    expect(currentTheme().id).toBe("tokyo-night");
    expect(workspaceThemeId("Open source")).toBe("tokyo-night");
  });

  it("drops entries for workspaces renamed or deleted elsewhere, and reverts when the active one vanishes", () => {
    setWorkspaceTheme("OSS", "tokyo-night");
    setWorkspaceTheme("Work", "nord");
    setWorkspaceTheme(null, "dracula");
    setActiveWorkspace("OSS");
    reconcileActiveWorkspace(list("Work"));
    expect(stored()).toEqual({ Work: "nord", "\u0000main": "dracula" });
    expect(currentTheme().id).toBe("dracula"); // fell back to Main
  });

  it("caches the override for the boot script only while it's on screen", () => {
    setWorkspaceTheme("OSS", "catppuccin-latte");
    setActiveWorkspace("OSS");
    expect(bootOverride()).toEqual({ appearance: "light", cssVars: LATTE.cssVars });
    // The global theme's slot still holds the global theme, not the override.
    expect(JSON.parse(localStorage.getItem("cc-theme-vars-dark")!)).toEqual(MOCHA.cssVars);
    expect(localStorage.getItem("cc-theme-vars-light")).toBeNull();

    setActiveWorkspace(null);
    expect(bootOverride()).toBeNull();
  });

  it("clears the boot override even when the global theme is the same palette", () => {
    setWorkspaceTheme("OSS", "catppuccin-mocha");
    setActiveWorkspace("OSS");
    applyTheme(resolveTheme());
    expect(bootOverride()).not.toBeNull();
    setActiveWorkspace(null); // same theme on screen: nothing redraws, but the cache follows
    expect(bootOverride()).toBeNull();
  });

  it("choosing a global theme under an override keeps the override on screen", () => {
    setWorkspaceTheme("OSS", "tokyo-night");
    setActiveWorkspace("OSS");
    chooseTheme(NORD);
    expect(currentTheme().id).toBe("tokyo-night");
    expect(JSON.parse(localStorage.getItem("cc-theme-vars-dark")!)).toEqual(NORD.cssVars);
    setActiveWorkspace(null);
    expect(currentTheme().id).toBe("nord");
  });
});
