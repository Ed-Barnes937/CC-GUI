# Custom themes

CC-GUI ships nineteen built-in themes — dark: Catppuccin Mocha, Catppuccin Frappé,
Catppuccin Macchiato, Tokyo Night, One Dark Pro, Dracula, Nord, Gruvbox Dark,
Everforest Dark, Rosé Pine, Kanagawa, Ayu Dark; light: Catppuccin Latte, GitHub
Light, Solarized Light, Gruvbox Light, Everforest Light, Rosé Pine Dawn, Daylight
(High Contrast). You can add your own without rebuilding the app by dropping JSON
files in the themes folder.

## Where themes live

```
~/Library/Application Support/co.genio.cc-gui/themes/*.json   (macOS)
```

One file = one theme. The fastest way to get there and to start from a working
file: open the command palette (**⌘K**) and run:

- **Theme: Open themes folder…** — reveals the folder (creates it if needed).
- **Theme: Export current theme as template…** — writes the *active* theme out as a
  complete, editable `*.json` you can tweak.

After editing, run **Theme: Reload custom themes**, then **Theme: \<your label\>** to
apply it. The active theme is marked `current` in the palette.

A full working example lives at [`example-theme.json`](./example-theme.json).

## File format

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✅ | Unique slug. Must **not** match a built-in id (`catppuccin-mocha`, `catppuccin-latte`, `catppuccin-frappe`, `catppuccin-macchiato`, `tokyo-night`, `one-dark-pro`, `dracula`, `nord`, `gruvbox-dark`, `everforest-dark`, `rose-pine`, `kanagawa`, `ayu-dark`, `github-light`, `solarized-light`, `gruvbox-light`, `everforest-light`, `rose-pine-dawn`, `daylight-hc`). |
| `label` | ✅ | Display name shown in the picker. |
| `appearance` | ✅ | `"light"` or `"dark"`. Determines which slot (preferred-light / preferred-dark) the theme fills, and the OS-appearance it's used for in System mode. |
| `cssVars` | optional | The 21 chrome color tokens (below). Any you omit are inherited from the base. |
| `terminal` | optional | xterm palette. Omitted keys inherited from the base. |
| `shiki` | optional | Syntax-highlighting colors — see below. |
| `base` | optional | A built-in id to inherit unset `cssVars`/`terminal`/`shiki` from. Defaults to the built-in matching `appearance`. |

### The 21 `cssVars` keys

```
bg-base  bg-elevated  bg-inset
border   border-strong   surface2
text     text-muted   text-dim   overlay1   subtext1
accent   success      danger   warning   attention   info   cyan
accent-tool   attn-blocked   tag-cool
```

`surface2` is a surface a touch lighter than `border-strong` (card-hover border,
muted-icon hover). `overlay1` is secondary muted text / faint icons, dimmer than
`text-muted`; `subtext1` is body paragraph text. `accent-tool` colors terminal
tool-call lines (lavender), `attn-blocked` is the blocked-state warning (maroon,
distinct from the peach `attention`), and `tag-cool` colors cool tag chips (teal).

All values are hex (`#rgb`, `#rrggbb`, or with alpha). An invalid value for a single
key is **dropped** (that key falls back to the inherited value) — it does not reject
the whole theme.

### Inheriting (partial themes)

You don't have to specify everything. A theme that only overrides a few tokens
inherits the rest from its `base` (or the matching built-in):

```json
{
  "id": "mocha-warmer",
  "label": "Mocha (warmer accent)",
  "appearance": "dark",
  "base": "catppuccin-mocha",
  "cssVars": { "accent": "#ffae57" }
}
```

### Syntax highlighting (`shiki`)

The diff viewer highlights code with [Shiki](https://shiki.style). Two options:

1. **Omit `shiki`** (recommended starting point) — your theme inherits the base
   built-in's syntax colors (Catppuccin Mocha for dark, Latte for light). Chrome and
   terminal use *your* colors; code highlighting borrows Catppuccin's.
2. **Provide a full TextMate / VS Code theme object** for designer-grade highlighting
   in your own palette:

   ```json
   {
     "id": "midnight",
     "label": "Midnight",
     "appearance": "dark",
     "shiki": {
       "type": "dark",
       "colors": { "editor.foreground": "#bfc7d5", "editor.background": "#0b0e14" },
       "tokenColors": [
         { "scope": "comment", "settings": { "foreground": "#5a6273" } },
         { "scope": "string", "settings": { "foreground": "#7fd962" } },
         { "scope": "keyword", "settings": { "foreground": "#baa0f9" } }
       ]
     }
   }
   ```

   (A `name` is added automatically.) Only this object form gives custom syntax
   colors — a `"shiki"` id string is only honoured when a built-in theme already
   uses it; any other id falls back to the base built-in's syntax colors.

## Validation & safety

- A malformed file (bad JSON, missing `id`/`label`/`appearance`, or an id that
  collides with a built-in) is **skipped**, and a toast lists which files were
  rejected and why. The rest still load.
- If your chosen theme's file is deleted or rejected, the app silently falls back to
  the built-in of that appearance. The built-ins can't be removed, so theming never
  breaks the app.
