// Shared Shiki highlighter for the review view and the markdown viewer: one
// lazily-created core instance, with languages and themes loaded on demand.
// We bundle only the languages LANG_LOADERS names and the theme ids the
// built-in registry uses; importing the full "shiki" bundle instead emits a
// lazy chunk for every one of Shiki's ~270 langs and ~60 themes (almost all
// unused). Each lang module inlines its embedded grammars (e.g. vue →
// html/css/ts), so loading one is self-contained.

import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
  type ThemeInput,
} from "shiki/core";
import type { Theme } from "./theme";

/** File extensions / fence aliases → the Shiki language id LANG_LOADERS knows. */
const LANG_ALIASES: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  kt: "kotlin",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  yml: "yaml",
  md: "markdown",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
};

const LANG_LOADERS: Record<string, LanguageInput> = {
  rust: () => import("@shikijs/langs/rust"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  ruby: () => import("@shikijs/langs/ruby"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  markdown: () => import("@shikijs/langs/markdown"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
};

const THEME_LOADERS: Record<string, ThemeInput> = {
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
  "catppuccin-latte": () => import("@shikijs/themes/catppuccin-latte"),
  "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
  "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
  "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  dracula: () => import("@shikijs/themes/dracula"),
  nord: () => import("@shikijs/themes/nord"),
  "github-light": () => import("@shikijs/themes/github-light"),
  "solarized-light": () => import("@shikijs/themes/solarized-light"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  // Languages and themes load on demand (ensureLang / ensureShikiTheme) rather
  // than up front: built-ins are bundled ids, custom themes supply a full
  // TextMate object at runtime, so the set isn't known at creation time.
  highlighterPromise ??= createHighlighterCore({
    themes: [],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighterPromise;
}

/** Map a file extension or code-fence info string to a loadable Shiki language
 *  id; null when we don't bundle a grammar for it. */
export function resolveLang(idOrExt: string): string | null {
  const key = idOrExt.toLowerCase();
  if (LANG_LOADERS[key]) return key;
  return LANG_ALIASES[key] ?? null;
}

// Shiki language ids already registered in the highlighter, so we never double-load.
const loadedLangs = new Set<string>();

// Shiki theme names already registered in the highlighter, so we never double-load.
const loadedThemes = new Set<string>();

/** Ensure a resolveLang-vetted language is registered in the highlighter. */
export async function ensureLang(hl: HighlighterCore, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  await hl.loadLanguage(LANG_LOADERS[lang]);
  loadedLangs.add(lang);
}

/**
 * Ensure the given theme's Shiki theme is loaded, and return the name to pass to
 * codeToTokens. A built-in's `shiki` is a bundled id (loaded by string); a custom
 * theme's is a full TextMate object whose `name` validateTheme forced to the theme
 * id. Keyed by that name so repeated renders reuse the already-loaded theme.
 */
export async function ensureShikiTheme(hl: HighlighterCore, theme: Theme): Promise<string> {
  const shiki = theme.shiki;
  const name = typeof shiki === "string" ? shiki : (shiki.name ?? theme.id);
  if (!loadedThemes.has(name)) {
    // A built-in id loads via its bundled loader; a custom theme's TextMate object
    // is passed straight through.
    await hl.loadTheme(typeof shiki === "string" ? THEME_LOADERS[shiki] : shiki);
    loadedThemes.add(name);
  }
  return name;
}
