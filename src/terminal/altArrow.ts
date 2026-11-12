// Bare Alt+arrow keys. xterm 5 rewrote these before sending them: Alt+Left/Right
// became readline's word back / forward, and off macOS Alt+Up/Down became
// Ctrl+Up/Down. xterm 6 sends the raw modified arrows (ESC [1;3A-D), which
// shells and TUIs mostly leave unbound. This restores the xterm 5 bytes:
// ESC b / ESC f on macOS, the Ctrl+arrow sequences (ESC [1;5A-D) elsewhere.
// xterm 5 never rewrote Alt+Up/Down on macOS, so there they are left to xterm.

type KeyChord = Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">;

/** The bytes a bare Alt+arrow chord sends, or null to leave `e` to xterm. Bare
 *  Alt only: Cmd+Opt+arrows are app shortcuts, and other combos pass through. */
export function altArrowBytes(e: KeyChord, isMac: boolean): string | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === "ArrowLeft") return isMac ? "\x1bb" : "\x1b[1;5D";
  if (e.key === "ArrowRight") return isMac ? "\x1bf" : "\x1b[1;5C";
  if (isMac) return null;
  if (e.key === "ArrowUp") return "\x1b[1;5A";
  if (e.key === "ArrowDown") return "\x1b[1;5B";
  return null;
}
