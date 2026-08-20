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
  type Theme,
} from "./index";

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
