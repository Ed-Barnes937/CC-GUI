// The title bar's counts and controls.
//
// The counts mirror into the Board's filter bar, so the attention pill this
// fills may be either or both (see chrome/attention.ts).

import { toast } from "../toast";
import { toggleHelp } from "../help";
import { togglePalette } from "../palette";
import { currentTheme } from "../theme";
import { openThemeModal } from "../themeModal";
import { registerView } from "../app/render";
import { tbAttention, tbBoard, tbConsole, tbCount } from "../app/elements";
import { groups } from "../app/store";
import { attentionCount, boardAttentionPill } from "./attention";
import { setLayout } from "./layout";
import { onboardingActive } from "./onboarding";

// The board's mirror of the attention pill; created with the filter bar.
export function updateTitleBarCounts(): void {
  const total = groups().reduce((n, g) => n + g.sessions.length, 0);
  const live = groups().flatMap((g) => g.sessions).filter((s) => s.status === "running").length;
  tbCount.textContent = `${total} sessions · ${live} live`;
  const waiting = attentionCount();
  tbAttention.textContent = `${waiting} waiting on you`;
  tbAttention.classList.toggle("hidden", waiting === 0);
  const mirror = boardAttentionPill();
  if (mirror) {
    mirror.textContent = `${waiting} waiting on you`;
    mirror.classList.toggle("hidden", waiting === 0);
  }
}

registerView("titlebar", updateTitleBarCounts);

// The title bar's own controls. The layout swap itself lives in
// chrome/layout.ts; these are the buttons that ask for it.
tbConsole.addEventListener("click", () => setLayout("console"));
tbBoard.addEventListener("click", () => {
  // The Board has nothing to show before the first project — keep the hero
  // (which lives in the Console's terminal pane) instead of a blank surface.
  if (onboardingActive()) {
    toast("Add a project first — the Board shows your sessions.");
    return;
  }
  setLayout("board");
});
document.querySelector<HTMLButtonElement>("#tb-jump")!.addEventListener("click", () => togglePalette());
document
  .querySelector<HTMLButtonElement>("#tb-theme")!
  .addEventListener("click", () => openThemeModal(currentTheme().appearance));
document.querySelector<HTMLButtonElement>("#tb-help")!.addEventListener("click", () => toggleHelp());
