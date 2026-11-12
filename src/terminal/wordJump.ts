// Opt+Left/Right word jumps. xterm 5 turned a bare Alt+Left/Right into
// readline's word back / forward; xterm 6 sends the raw modified arrows
// (ESC [1;3D / ESC [1;3C), which shells and TUIs mostly leave unbound. This
// restores the xterm 5 bytes: ESC b / ESC f on macOS, Ctrl+Left/Right
// (ESC [1;5D / ESC [1;5C) elsewhere.

type KeyChord = Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">;

/** The bytes a word-jump chord sends, or null when `e` is not one. Bare Alt
 *  only: Cmd+Opt+Left/Right cycles tabs, and other combos pass through. */
export function wordJumpBytes(e: KeyChord, isMac: boolean): string | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === "ArrowLeft") return isMac ? "\x1bb" : "\x1b[1;5D";
  if (e.key === "ArrowRight") return isMac ? "\x1bf" : "\x1b[1;5C";
  return null;
}
