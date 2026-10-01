// The title bar's workspace chip, its menu, and what a switch does to the
// screen.
//
// app/workspaces.ts owns the active workspace and app/store.ts scopes the
// snapshot to it; this is the part that touches views. Every switch goes
// through one listener here -- a click in the menu, a key, the palette, the
// startup choice, a workspace vanishing -- so per-workspace view memory and
// the filters that can't outlive a switch are handled in one place.

import { invoke } from "@tauri-apps/api/core";
import { toast, promptDialog } from "../toast";
import { dismissMenu, menuOpen, showMenuBelow, type MenuItem } from "../menu";
import { kb } from "../keys";
import type { PaletteEntry } from "../palette";
import { openSettings } from "../settings";
import { refreshNow } from "../app/actions";
import { registerView, renderAll } from "../app/render";
import { tbCount, tbWorkspace, tbWorkspaceLabel } from "../app/elements";
import { allGroups, groups, hasSnapshot, sessionInScope, workspaces } from "../app/store";
import type { WorkspaceEntry } from "../app/types";
import {
  activeEntry,
  activeWorkspace,
  cycleWorkspace,
  expectWorkspace,
  onWorkspaceChange,
  projectCount,
  rememberView,
  setActiveWorkspace,
  validateWorkspaceName,
  viewMemory,
  workspaceShortcut,
  workspacesVisible,
} from "../app/workspaces";
import { activeTerm } from "../terminal/state";
import { scopeTerminals } from "../terminal/surface";
import { selectRow, selectedSession } from "../session/selection";
import { setNewSessionProject, setProjectFilter } from "../sidebar/state";
import { boardProjectFilter, setBoardProjectFilter } from "../board/state";

// ------------------------------------------------------------------ switch

/** Show workspace `name` (null = Main). */
export function switchWorkspace(name: string | null): void {
  setActiveWorkspace(name, "switch");
}

/** Jump to the workspace at `index` in display order (Cmd+Shift+1..9). */
export function switchToWorkspaceAt(index: number): void {
  const w = workspaces()[index];
  if (w) switchWorkspace(w.name);
}

/** Next / previous workspace, wrapping. With one workspace there's nowhere to
 *  go, so say so (as the TUI does) rather than silently doing nothing. */
export function cycleWorkspaces(forward: boolean): void {
  const list = workspaces();
  if (!workspacesVisible(list)) {
    toast('Only one workspace - create another with "New workspace…"');
    return;
  }
  switchWorkspace(cycleWorkspace(list, activeWorkspace(), forward));
}

// The one place a switch reaches the views. The old workspace's cursor and tab
// are remembered on a real switch (at boot nothing is on screen yet, and a
// vanished workspace has nothing to come back to); the new one's are restored
// where they still exist. Filters naming the old workspace's projects would
// leave the new one blank, so they reset, as the TUI drops its board filter.
onWorkspaceChange(({ prev, next, reason }) => {
  if (reason === "switch") rememberView(prev, { selected: selectedSession(), tab: activeTerm() });
  setProjectFilter(null);
  setNewSessionProject(null);
  setBoardProjectFilter(null);
  const memory = viewMemory(next);
  selectRow(memory.selected && sessionInScope(memory.selected) ? memory.selected : null);
  scopeTerminals(memory.tab);
  // The startup choice lands before the first snapshot; drawing then would
  // paint an empty world (and the first-run hero) for a moment.
  if (hasSnapshot()) renderAll();
});

// --------------------------------------------------------------- creating

/** Ask for a new workspace's name (checked inline against the protocol's
 *  rules) and create it. Resolves to its stored name, or null if cancelled or
 *  refused. The backend re-validates; a refusal (a clash with one the TUI just
 *  made, say) arrives as a toast. The new workspace is expected and the
 *  snapshot refreshed, so a switch to it right after sticks. */
export async function createWorkspaceFromPrompt(): Promise<string | null> {
  const raw = await promptDialog("New workspace", "Workspace name", "Create", (value) => {
    const check = validateWorkspaceName(value, workspaces());
    return check.ok ? null : check.error;
  });
  if (raw === null) return null;
  let name: string;
  try {
    name = await invoke<string>("create_workspace", { name: raw });
  } catch (e) {
    toast(`Couldn't create the workspace: ${e}`, "error");
    return null;
  }
  // A push built before the create could land after the switch and look like
  // the workspace vanished; holding it as expected keeps the switch.
  expectWorkspace(name);
  await refreshNow();
  return name;
}

/** Create a workspace (see createWorkspaceFromPrompt) and switch to it. */
export async function newWorkspace(): Promise<void> {
  const name = await createWorkspaceFromPrompt();
  if (name !== null) switchWorkspace(name);
}

/** Workspace settings. The Settings modal gains a Workspaces tab later; until
 *  then this opens Settings. */
function manageWorkspaces(): void {
  void openSettings();
}

// --------------------------------------------------------------- the menu

const countLabel = (n: number) => `${n} ${n === 1 ? "project" : "projects"}`;

/** The workspace rows of the chip's menu: a tick, project counts,
 *  Cmd+Shift+N. `pick` is what a row does. The tick goes on `ticked` (the
 *  active workspace unless told otherwise); `inert` rows do nothing (a
 *  project's own workspace, when the menu is a drop target for it). */
export function workspaceRows(
  pick: (w: WorkspaceEntry) => void,
  {
    ticked = activeWorkspace(),
    inert = () => false,
  }: { ticked?: string | null; inert?: (w: WorkspaceEntry) => boolean } = {},
): MenuItem[] {
  const projects = allGroups();
  return workspaces().map(
    (w, i): MenuItem => ({
      label: w.label,
      checked: w.name === ticked,
      meta: countLabel(projectCount(projects, w.name)),
      shortcut: workspaceShortcut(i),
      disabled: inert(w) || undefined,
      action: () => pick(w),
    }),
  );
}

function menuItems(): MenuItem[] {
  return [
    { header: "Workspaces" },
    ...workspaceRows((w) => switchWorkspace(w.name)),
    "separator",
    { label: "New workspace…", indent: true, action: () => void newWorkspace() },
    { label: "Manage workspaces…", indent: true, action: manageWorkspaces },
  ];
}

/** Where a title-bar workspace menu opens: under the chip, or, with only Main
 *  (the chip hidden), under the session count. */
export function workspaceMenuAnchor(): HTMLElement {
  return tbWorkspace.classList.contains("hidden") ? tbCount : tbWorkspace;
}

/** Open `items` as a workspace menu under the chip, the chip drawn open until
 *  it closes. `onClose` runs after the chip is reset. */
export function showWorkspaceMenu(items: MenuItem[], onClose?: () => void): void {
  tbWorkspace.classList.add("open");
  tbWorkspace.setAttribute("aria-expanded", "true");
  showMenuBelow(workspaceMenuAnchor(), items, {
    className: "workspace-menu",
    onClose: () => {
      tbWorkspace.classList.remove("open");
      tbWorkspace.setAttribute("aria-expanded", "false");
      onClose?.();
    },
  });
}

/** Open the workspace menu under the chip (the workspace_picker key). With
 *  only Main the chip is hidden, so it opens under the session count instead,
 *  which is still the way to create the first workspace from the keyboard. */
export function openWorkspaceMenu(): void {
  showWorkspaceMenu(menuItems());
}

tbWorkspace.addEventListener("click", (e) => {
  // Kept from the document-level click that dismisses menus, so it can toggle.
  e.stopPropagation();
  if (menuOpen() && tbWorkspace.classList.contains("open")) dismissMenu();
  else openWorkspaceMenu();
});

// ----------------------------------------------------------------- render

/** The chip shows the active workspace once a second one exists. Every
 *  snapshot also re-checks the screen against the scope: a project moved to
 *  another workspace (from here or from the TUI) takes its cursor, its
 *  terminals and any Board filter pick naming it with it. Its terminals leave the strip
 *  but stay attached, as a switch leaves them. */
function renderWorkspaces(): void {
  const list = workspaces();
  tbWorkspace.classList.toggle("hidden", !workspacesVisible(list));
  tbWorkspaceLabel.textContent = activeEntry(list, activeWorkspace()).label;
  const selected = selectedSession();
  if (selected && !sessionInScope(selected)) selectRow(null);
  scopeTerminals();
  scopeFilters();
}

/** Drop the Board's picks of projects the active workspace no longer has; if
 *  none of its picks are left, fall back to every project rather than leave
 *  an empty board nobody asked for. (A deliberate "Clear all" stays empty.) */
function scopeFilters(): void {
  const board = boardProjectFilter();
  if (!board) return;
  const ids = new Set(groups().map((g) => g.id));
  if (![...board].some((id) => !ids.has(id))) return;
  const kept = new Set([...board].filter((id) => ids.has(id)));
  setBoardProjectFilter(kept.size ? kept : null);
}

registerView("workspaces", renderWorkspaces);

// ---------------------------------------------------------------- palette

/** The palette's workspace commands: "Switch workspace: <name>" for every
 *  other workspace (once there is one), and "New workspace…". */
export function workspacePaletteEntries(): PaletteEntry[] {
  const list = workspaces();
  const active = activeWorkspace();
  const switches: PaletteEntry[] = workspacesVisible(list)
    ? list.flatMap((w, i) =>
        w.name === active
          ? []
          : [
              {
                label: `Switch workspace: ${w.label}`,
                hint: countLabel(projectCount(allGroups(), w.name)),
                icon: "◇",
                iconTone: "info",
                shortcut: workspaceShortcut(i),
                action: () => switchWorkspace(w.name),
              },
            ],
      )
    : [];
  return [
    ...switches,
    {
      label: "New workspace…",
      hint: "command",
      icon: "◇",
      iconTone: "success",
      shortcut: kb("new_workspace"),
      action: () => void newWorkspace(),
    },
  ];
}
