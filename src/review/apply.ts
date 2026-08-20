// The apply bar: how many comments are staged, and the two-press guard before
// they are sent to the agent.
//
// Sending is irreversible -- it hands the comments over and clears them -- so
// the button arms on the first press and only sends on the second, disarming
// itself after a few seconds so a stray click never leaves it primed.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { describeOutcome, type ApplyOutcome } from "./model";
import {
  applyBarEl,
  applyEl,
  applySummaryEl,
  closeReview,
  redraw,
  refreshReview,
  registerPane,
  sessionId,
  snapshot,
  statusEl,
} from "./state";

let applying = false;
let armed = false;
let armTimer: number | null = null;

export function isArmed(): boolean {
  return armed;
}

export function renderApply(): void {
  const snap = snapshot();
  if (!snap) {
    applyBarEl.classList.add("hidden");
    return;
  }
  const pending = snap.comments.filter((c) => c.status !== "applied").length;
  applyBarEl.classList.toggle("hidden", pending === 0);
  if (pending === 0) disarm();
  const noun = pending === 1 ? "comment" : "comments";
  applyEl.disabled = applying;
  applyEl.classList.toggle("armed", armed && !applying);
  if (applying) {
    applySummaryEl.textContent = `Sending ${pending} ${noun} to the agent…`;
    applyEl.textContent = "Sending…";
  } else if (armed) {
    applySummaryEl.textContent = "This sends the comments to the agent — press again to confirm, Esc to cancel.";
    applyEl.textContent = `Confirm — send ${pending} ${noun}`;
  } else {
    applySummaryEl.textContent = `${pending} ${noun} ready to send back to the agent`;
    applyEl.textContent = `Apply ${pending} ${noun} →`;
  }
}

/** Arm the send on the first press; a second press within the window confirms.
 *  Sending is irreversible, so this is the guard against an accidental apply. */
export function requestApply(): void {
  if (!sessionId() || applying) return;
  if (!armed) {
    armed = true;
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = window.setTimeout(disarm, 4000);
    redraw("apply");
    return;
  }
  disarm();
  void applyComments();
}

export function disarm(): void {
  if (armTimer !== null) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  if (!armed) return;
  armed = false;
  redraw("apply");
}

async function applyComments(): Promise<void> {
  if (!sessionId() || applying) return;
  applying = true;
  statusEl.textContent = "";
  redraw("apply");
  try {
    const outcome = await invoke<ApplyOutcome>("apply_comments", { id: sessionId() });
    // Applying clears the staged comments and returns to the workspace; a
    // blocked outcome (drifted comments) stays open so the failure is visible.
    if (outcome.outcome === "applied") {
      applying = false;
      // Confirm the send before teardown — a toast lives on <body>, so it
      // survives closeReview() and stays readable after the panel is gone.
      toast(describeOutcome(outcome));
      closeReview();
      return;
    }
    statusEl.textContent = describeOutcome(outcome);
  } catch (e) {
    statusEl.textContent = "Couldn't send the comments. Please try again.";
    toast("Couldn't send the comments to the agent.", "error", String(e));
  }
  applying = false;
  await refreshReview();
}

registerPane("apply", renderApply);
