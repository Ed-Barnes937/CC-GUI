// The first-run hero, shown in the Console's terminal pane until there is
// something to show instead.
//
// It gates on more than the project count: attaching a terminal (including
// through the hero's own commander button) is enough to replace it, so the
// hero can't end up rendered on top of the session it just started.

import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "../toast";
import { registerView, requestRender } from "../app/render";
import { actionErrorToast, refreshNow } from "../app/actions";
import {
  commanderChip,
  onboardingAddProjectBtn,
  onboardingCommanderBtn,
  onboardingEl,
} from "../app/elements";
import { commanderEnabled, groups, layout } from "../app/store";
import { terminals } from "../terminal/state";
import { setTopInput } from "../sidebar/state";
import { setLayout } from "./layout";

//
// First-run hero over the terminal pane. Shown whenever there are zero
// projects AND no terminal is attached — attaching one (e.g. via the hero's
// own commander CTA) must yield the hero, not leave it rendered on top of
// the freshly attached terminal (see updatePlaceholder). No persisted flag;
// purely driven by the live snapshot (applySnapshot) and terminal attach/detach.


/** First-run hero state: no projects and nothing attached. */
export function onboardingActive(): boolean {
  return groups().length === 0 && terminals.size === 0;
}

export function renderOnboarding(): void {
  const show = onboardingActive();
  const wasShown = !onboardingEl.classList.contains("hidden");
  onboardingEl.classList.toggle("hidden", !show);
  // Board layout hides #terminal-pane, which hosts the hero — so a persisted
  // Board layout (or deleting the last project while on the Board) would show
  // a blank surface instead of first-run guidance. Yield to Console while the
  // hero is up; the Board segment is guarded below for the same reason.
  if (show && layout() === "board") setLayout("console");
  // Card 3 is only a live control when the commander is actually configured —
  // otherwise it reads inert, like card 2's "After a project" placeholder,
  // rather than firing prepare_commander into a raw error toast.
  onboardingCommanderBtn.disabled = !commanderEnabled();
  onboardingCommanderBtn.classList.toggle("outline", commanderEnabled());
  onboardingCommanderBtn.classList.toggle("muted", !commanderEnabled());
  // On first show, focus the primary path so Enter fires "Choose folder…"
  // (the ⏎-hinted CTA) rather than nothing — card 3's commander button is
  // disabled here, so it must never be the implicit Enter target.
  if (show && !wasShown) onboardingAddProjectBtn.focus();
}

registerView("onboarding", renderOnboarding);

onboardingAddProjectBtn.addEventListener("click", () => {
  // Same native folder-picker the sidebar's Browse… uses; a cancel (no path
  // picked) falls back to revealing the sidebar's path input so they can
  // type it instead.
  void openFolderDialog({ directory: true }).then((picked) => {
    if (typeof picked === "string") {
      const name = picked.replace(/\/+$/, "").split("/").pop() || picked;
      invoke("add_project", { path: picked })
        .then(() => toast(`Added ${name}.`))
        .catch((err) => actionErrorToast("add_project", err))
        .finally(() => void refreshNow());
    } else {
      setTopInput("add");
      requestRender("sidebar");
    }
  });
});

onboardingCommanderBtn.addEventListener("click", () => commanderChip.click());
