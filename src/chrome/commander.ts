// The commander chip in the title bar: the persistent claude-commander
// session, and the click that attaches it.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { registerView } from "../app/render";
import { commanderChip } from "../app/elements";
import { commanderStatus } from "../app/store";
import type { Snapshot } from "../app/types";
import { attachTerminal } from "../terminal/attach";

function renderCommander(c: Snapshot["commander"]): void {
  commanderChip.classList.toggle("hidden", !c.enabled);
  if (!c.enabled) return;
  commanderChip.innerHTML = "";
  const square = document.createElement("span");
  square.className = "commander-square";
  square.title = c.running ? "running" : "stopped";
  const label = document.createElement("span");
  label.className = "commander-label";
  label.textContent = "commander";
  const attach = document.createElement("span");
  attach.className = "commander-attach";
  attach.textContent = "attach ⏎";
  commanderChip.append(square, label, attach);
}

registerView("commander", () => renderCommander(commanderStatus()));

commanderChip.addEventListener("click", () => {
  void (async () => {
    let name: string;
    try {
      name = await invoke<string>("prepare_commander");
    } catch (e) {
      toast(`commander failed: ${e}`, "error");
      return;
    }
    await attachTerminal(name, "commander", null);
  })();
});
