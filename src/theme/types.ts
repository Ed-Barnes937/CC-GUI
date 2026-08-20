// The shape of a theme. Its own module because the palettes below it and the
// manager above it both need these types, and nothing here imports anything but
// the two consumer libraries' type declarations.

import type { ITheme } from "@xterm/xterm";
import type { ThemeRegistration } from "@pierre/diffs";

export type Appearance = "light" | "dark";
export type Mode = "light" | "dark" | "system";

export interface Theme {
  id: string;
  label: string;
  appearance: Appearance;
  /** Where the theme came from — built-ins vs. user files (for picker grouping). */
  source: "builtin" | "custom";
  /** Built-in id this theme inherited unset cssVars/terminal/shiki from, if any. */
  base?: string;
  /** Semantic CSS custom properties, keyed without the leading `--`. */
  cssVars: Record<string, string>;
  /** Full xterm palette (consumed in Phase 3). */
  terminal: ITheme;
  /** A bundled Shiki theme id, or a full TextMate theme object (custom themes). */
  shiki: string | ThemeRegistration;
}
