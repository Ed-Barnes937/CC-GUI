// Backend commands that mutate a session, and the toasts they raise on
// failure.
//
// Sidebar rows, board cards, the palette and the keybinding table all offer
// the same handful of operations, so they share one wrapper apiece rather than
// each repeating the invoke/catch/refresh dance. Every one ends with
// refreshNow() so the screen reflects the change without waiting on the push
// loop's next tick.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { applySnapshot } from "./store";
import type { Snapshot } from "./types";

/** Pull a fresh snapshot and redraw. */
export async function refreshNow(): Promise<void> {
  try {
    applySnapshot(await invoke<Snapshot>("get_groups"));
  } catch {
    // transient; the next push tick recovers
  }
}

/** Plain-language verb per lifecycle/command action, for error toasts. */
const ACTION_VERB: Record<string, string> = {
  kill_session: "stop the session",
  restart_session: "restart the session",
  restart_fresh: "restart the session fresh",
  delete_session: "delete the session",
  move_to_section: "move the session",
  cascade_merge: "merge the stack",
  push_stack: "push the stack",
  cascade_resume: "resume the stack",
  cascade_abandon: "abandon the stack",
};

/** Error toast naming the action in plain language; the raw backend error is
 *  kept on the hover title rather than shown inline. */
export function actionErrorToast(action: string, e: unknown): void {
  const verb = ACTION_VERB[action] ?? action.replace(/_/g, " ");
  toast(`Couldn't ${verb}.`, "error", String(e));
}

export async function lifecycle(action: string, id: string): Promise<void> {
  await lifecycleArgs(action, { id });
}

export async function lifecycleArgs(action: string, args: Record<string, unknown>): Promise<void> {
  try {
    await invoke(action, args);
  } catch (e) {
    actionErrorToast(action, e);
  }
  await refreshNow();
}

/** Invoke a long-running command and surface its summary (or error). */
export async function invokeToast(action: string, args: Record<string, unknown>): Promise<void> {
  try {
    const msg = await invoke<string | null>(action, args);
    if (msg) toast(msg);
  } catch (e) {
    actionErrorToast(action, e);
  }
  await refreshNow();
}
