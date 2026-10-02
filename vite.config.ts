import { defineConfig, type Plugin } from "vite";
import { KEY_OVERRIDE_VARS, THEMES, type Theme } from "./src/theme";

// No-flash boot: inject the default light/dark CSS var sets (derived from the
// theme registry — single source, no drift) plus a tiny pre-paint script that
// picks the appearance from localStorage + the OS preference before first paint.
// `html[data-appearance=…]` (specificity 0,1,1) overrides the :root defaults
// (0,1,0) regardless of source order; runtime inline styles from applyTheme()
// override both after hydration.
function themeBoot(): Plugin {
  const byAppearance = (a: Theme["appearance"]) =>
    Object.values(THEMES).find((t) => t.appearance === a)!;
  const block = (sel: string, t: Theme) =>
    `${sel}{${Object.entries(t.cssVars)
      .map(([k, v]) => `--${k}:${v}`)
      .join(";")}}`;
  const css =
    block('html[data-appearance="dark"]', byAppearance("dark")) +
    block('html[data-appearance="light"]', byAppearance("light"));
  // Set the appearance, then replay the active theme's cached cssVars (written by
  // applyTheme) as inline styles. The cache is the only way a *custom* theme —
  // unknown at build time, so absent from the injected blocks above — paints
  // correctly before first paint. No cache (first run) falls back to those blocks.
  // A workspace override on screen at quit was cached on its own, appearance
  // included (an override ignores the mode), and wins: relaunching into the
  // same workspace paints it. A launch into a different workspace (a pinned
  // startup one) can flash it once; see docs/theming.md.
  const script =
    "try{var r=document.documentElement,a,o;" +
    `var w=localStorage.getItem('${KEY_OVERRIDE_VARS}');` +
    "if(w){w=JSON.parse(w);a=w.appearance==='light'?'light':'dark';o=w.cssVars;}else{" +
    "var m=localStorage.getItem('cc-theme-mode')||'system';" +
    "var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);" +
    "a=d?'dark':'light';var v=localStorage.getItem('cc-theme-vars-'+a);if(v)o=JSON.parse(v);}" +
    "r.dataset.appearance=a;" +
    "if(o){for(var k in o)r.style.setProperty('--'+k,o[k]);}" +
    "}catch(e){}";
  return {
    name: "theme-boot",
    transformIndexHtml: () => [
      { tag: "style", injectTo: "head", children: css },
      { tag: "script", injectTo: "head", children: script },
    ],
  };
}

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json devUrl)
export default defineConfig({
  plugins: [themeBoot()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // Inline the bundled terminal font as a data: URI. macOS WKWebView silently
    // refuses to apply @font-face web fonts served over Tauri's custom asset
    // protocol in packaged builds, so an emitted .woff2 file loads in `tauri dev`
    // (plain HTTP) but never in the installed app. A data: URI sidesteps the
    // protocol entirely. Only the font is inlined; everything else keeps Vite's
    // default 4 KB threshold.
    assetsInlineLimit: (filePath) =>
      filePath.includes("MesloLGSNF") ? true : undefined,
  },
});
