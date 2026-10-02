// Moving a project to another workspace (handoff 1c): the project header's
// "Move to workspace ▸" submenu, the move_project_to_workspace key, and
// dragging a project header onto the title-bar chip.
//
// A move is one tag change on the backend. What it does to the screen -- the
// project leaving the view, its cursor cleared, its terminals dropped from the
// strip but kept attached -- follows from the next snapshot, through the same
// scope check a switch uses (chrome/workspaces.ts), so a move made from the
// TUI lands the same way.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import { dismissMenu, type MenuItem } from "../menu";
import { draggable } from "../drag";
import type { PaletteEntry } from "../palette";
import { kb } from "../keys";
import { refreshNow } from "../app/actions";
import { tbWorkspace } from "../app/elements";
import { groupOf, groups, workspaces } from "../app/store";
import type { ProjectGroup, WorkspaceEntry } from "../app/types";
import { activeEntry, workspacesVisible } from "../app/workspaces";
import { projClass } from "../session/row";
import { targetSession } from "../session/selection";
import { createWorkspaceFromPrompt, showWorkspaceMenu, switchWorkspace, workspaceRows } from "./workspaces";

// ------------------------------------------------------------------- move

/** A project's workspace (null = Main). */
const workspaceOf = (group: ProjectGroup): string | null => group.workspace ?? null;

/** Tag `group` with workspace `target` (null = Main), then offer to follow it
 *  there. Moving to the workspace it's already in is a no-op. */
export async function moveProjectTo(group: ProjectGroup, target: string | null): Promise<void> {
  if (workspaceOf(group) === target) return;
  try {
    await invoke("set_project_workspace", { projectId: group.id, workspace: target });
  } catch (e) {
    toast(`Couldn't move ${group.name}.`, "error", String(e));
    return;
  }
  await refreshNow();
  const label = workspaces().find((w) => w.name === target)?.label ?? target ?? activeEntry(workspaces(), null).label;
  toast(`Moved ${group.name} to ${label}`, "info", undefined, {
    label: `Switch to ${label}`,
    run: () => switchWorkspace(target),
  });
}

/** Ask for a new workspace, create it, and move `group` into it. Created
 *  first, with its own checks, rather than left to the move's auto-define:
 *  that path takes any valid name, so a stale list could let "work" in beside
 *  "Work", which every later edit of the list would then refuse. */
async function moveProjectToNew(group: ProjectGroup): Promise<void> {
  const name = await createWorkspaceFromPrompt();
  if (name !== null) await moveProjectTo(group, name);
}

// --------------------------------------------------------------- the menus

/** Whether moving is on offer: as with the chip, only once a second
 *  workspace exists, so the project menu is unchanged until then. */
export function moveOffered(): boolean {
  return workspacesVisible(workspaces());
}

/** The "Move to workspace ▸" submenu: every workspace, the project's own
 *  ticked, dimmed and tagged "current", then "New workspace…". */
export function moveSubmenuItems(group: ProjectGroup): MenuItem[] {
  const current = workspaceOf(group);
  return [
    ...workspaces().map(
      (w): MenuItem => ({
        label: w.label,
        checked: w.name === current,
        disabled: w.name === current || undefined,
        tag: w.name === current ? "current" : undefined,
        action: () => void moveProjectTo(group, w.name),
      }),
    ),
    "separator",
    { label: "New workspace…", indent: true, action: () => void moveProjectToNew(group) },
  ];
}

/** The project header menu's entry, or nothing while only Main exists. */
export function moveMenuEntry(group: ProjectGroup): MenuItem[] {
  return moveOffered() ? [{ label: "Move to workspace", submenu: () => moveSubmenuItems(group) }, "separator"] : [];
}

/** The project the key and the palette act on: the cursor session's. */
function targetProject(): ProjectGroup | undefined {
  const s = targetSession();
  return s ? groupOf(s.id) : undefined;
}

/** move_project_to_workspace: the move menu for the cursor session's project,
 *  under the chip. */
export function openMoveProjectMenu(group: ProjectGroup | undefined = targetProject()): void {
  if (!group) return;
  showWorkspaceMenu([{ header: `Move ${group.name} to` }, ...moveSubmenuItems(group)]);
}

/** "Move project to workspace…" in the palette, for the cursor's project. */
export function movePaletteEntries(): PaletteEntry[] {
  const group = targetProject();
  if (!group || !moveOffered()) return [];
  return [
    {
      label: "Move project to workspace…",
      hint: group.name,
      icon: "◇",
      iconTone: "info",
      shortcut: kb("move_project_to_workspace"),
      // The palette runs this inside the click that picked it, and that click
      // would dismiss a menu opened now on its way up to the document.
      action: () => setTimeout(() => openMoveProjectMenu(group)),
    },
  ];
}

// ------------------------------------------------------------------- drag

/** Make a project header draggable onto the workspace chip. Over the chip the
 *  workspace menu opens as a drop target; dropping on a row moves the project
 *  there ("New workspace…" asks for a name first). Released anywhere else, or
 *  Esc, nothing moves. `id` names the project rather than holding its row, so
 *  a drop acts on the project as it is then. */
export function draggableToWorkspace(header: HTMLElement, projectId: string): void {
  draggable(header, () => {
    const group = groups().find((g) => g.id === projectId);
    if (!group || !moveOffered()) return null;
    header.classList.add("dragging");
    const ghost = dragGhost(group);
    let menuOpen = false;
    let lit: HTMLElement | null = null;

    const light = (row: HTMLElement | null) => {
      if (row === lit) return;
      lit?.classList.remove("drop-hover");
      lit = row;
      lit?.classList.add("drop-hover");
      ghost.target.textContent = `→ move to ${dropLabel(row)}`;
    };
    const openDropMenu = () => {
      menuOpen = true;
      tbWorkspace.classList.add("drag-over");
      showWorkspaceMenu(dropMenuItems(group), () => {
        menuOpen = false;
        lit = null;
        tbWorkspace.classList.remove("drag-over");
      });
    };
    const rowAt = (x: number, y: number): HTMLElement | null => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".workspace-menu .menu-item");
      return row && !row.classList.contains("disabled") ? row : null;
    };

    return {
      onMove(x, y) {
        ghost.el.style.left = `${x + 12}px`;
        ghost.el.style.top = `${y + 12}px`;
        if (!menuOpen && document.elementFromPoint(x, y)?.closest("#tb-workspace")) openDropMenu();
        light(menuOpen ? rowAt(x, y) : null);
      },
      onDrop(x, y) {
        // The row's own click runs the move and closes the menu.
        if (menuOpen) rowAt(x, y)?.click();
      },
      onEnd() {
        header.classList.remove("dragging");
        ghost.el.remove();
        if (menuOpen) dismissMenu();
      },
    };
  });
}

/** The chip's menu as a drop target: the same rows, each moving the project
 *  rather than switching to it, the project's own workspace inert. "Manage
 *  workspaces…" is left out: there's nothing to drop a project on there. */
function dropMenuItems(group: ProjectGroup): MenuItem[] {
  const current = workspaceOf(group);
  return [
    { header: "Workspaces" },
    ...workspaceRows((w: WorkspaceEntry) => void moveProjectTo(group, w.name), {
      ticked: current,
      inert: (w) => w.name === current,
    }),
    "separator",
    { label: "New workspace…", indent: true, action: () => void moveProjectToNew(group) },
  ];
}

/** What the ghost says it'll do over `row`. */
function dropLabel(row: HTMLElement | null): string {
  if (!row) return "workspace";
  if (!row.classList.contains("checkable")) return "a new workspace";
  return row.querySelector(".menu-label")?.textContent ?? "workspace";
}

/** The mini project header that follows the pointer. */
function dragGhost(group: ProjectGroup): { el: HTMLDivElement; target: HTMLSpanElement } {
  const el = document.createElement("div");
  el.className = "project-drag-ghost";
  const square = document.createElement("span");
  square.className = `proj-square ${projClass(group.id)}`;
  const name = document.createElement("span");
  name.textContent = group.name;
  const target = document.createElement("span");
  target.className = "ghost-target";
  target.textContent = `→ move to ${dropLabel(null)}`;
  el.append(square, name, target);
  document.body.appendChild(el);
  return { el, target };
}
