// Reconnecting a terminal whose tmux session ended.
//
// The TUI restarts a crashed session inside its attach loop and gets the
// crash-loop cap for free. The GUI has no such loop, so the cap is kept per
// tmux name here, and the restart deliberately reconnects the PTY on the SAME
// terminal: a background session finishing must not steal the pane you are
// working in.

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activeTerm, panes, refitActive, splitActive, terminals } from "./state";
import { scheduleFit } from "./surface";

/**
 * Crash-loop guard, cap 3 *consecutive* ends per tmux name. "Consecutive"
 * means in quick succession: an end more than a minute after the previous one
 * starts a fresh count, so a session that ran healthily for a while regains
 * its auto-restart budget (the TUI gets this for free by scoping its counter
 * to one attach loop).
 */
const consecutiveEnds = new Map<string, { count: number; lastEnd: number }>();

function recordEndAndCheckRestart(name: string): boolean {
  if (name.endsWith("-sh") || name === "cc-commander") return false;
  const prev = consecutiveEnds.get(name);
  const now = Date.now();
  const count = prev && now - prev.lastEnd < 60_000 ? prev.count + 1 : 1;
  consecutiveEnds.set(name, { count, lastEnd: now });
  return count <= 3;
}

/**
 * Auto-restart a crashed session by reconnecting the PTY on the SAME terminal,
 * without tearing it down. This preserves the terminal's placement (its pane in
 * split mode, or parked/active in single mode) and the user's focus. A
 * user-initiated attach deliberately loads into the focused pane; an autonomous
 * restart must not — otherwise a background tab finishing would hijack the pane
 * you're working in, or a crashed pane would reappear in the wrong quadrant.
 */
export async function restartTerminalInPlace(name: string): Promise<void> {
  const entry = terminals.get(name);
  if (!entry) return;
  try {
    await invoke("restart_fresh", { tmuxSession: name });
    const onData = new Channel<number[]>();
    onData.onmessage = (chunk) => entry.term.write(new Uint8Array(chunk));
    await invoke("attach", { tmuxSession: name, onData });
    entry.dead = false;
    entry.tab.classList.remove("dead");
    // Refit wherever it currently lives; parked terminals need no refit.
    if (splitActive() && [...panes.values()].includes(name)) scheduleFit(name);
    else if (activeTerm() === name) refitActive();
  } catch (e) {
    entry.term.write(`\r\nAuto-restart failed: ${e}\r\n`);
  }
}

void listen<{ session: string; ended: boolean }>("pty-exit", (event) => {
  const { session: name, ended } = event.payload;
  const entry = terminals.get(name);
  if (!entry) return;
  entry.dead = true;
  entry.tab.classList.add("dead");

  // The tmux session ended (program exited/crashed) rather than a detach:
  // auto-restart fresh and re-attach in place, with the crash-loop guard — the
  // same behaviour as the TUI's attach loop.
  if (ended && recordEndAndCheckRestart(name)) {
    entry.term.write("\r\n\x1b[90m[session ended — restarting…]\x1b[0m\r\n");
    void restartTerminalInPlace(name);
    return;
  }
  entry.term.write("\r\n\x1b[90m[detached — click session to re-attach]\x1b[0m\r\n");
});

/** A deliberate attach resets the crash-loop guard for this session. */
export function resetRestartBudget(name: string): void {
  consecutiveEnds.delete(name);
}
