// The sidebar's two context menus: one per project header, one for the
// sidebar as a whole (the "..." button).
//
// The per-session menu is not here -- it's shared with the board and lives in
// session/row.ts.

import { invoke } from "@tauri-apps/api/core";
import { toast, confirmDialog } from "../toast";
import type { MenuItem } from "../menu";
import { kb } from "../keys";
import { toggleHelp } from "../help";
import { openSettings } from "../settings";
import { requestRender } from "../app/render";
import { lifecycle } from "../app/actions";
import { findSession } from "../app/store";
import type { ProjectGroup } from "../app/types";
import { openProjectShell } from "../terminal/attach";
import { deleteSession } from "../session/row";
import { setNewSessionProject, setTopInput } from "./state";

export function projectMenuItems(group: ProjectGroup, createKey: string = group.id): MenuItem[] {
  return [
    {
      label: "New session…",
      shortcut: kb("new_session"),
      action: () => {
        setNewSessionProject(createKey);
        requestRender("sidebar");
      },
    },
    { label: "Project shell", action: () => void openProjectShell(group) },
    "separator",
    {
      label: "Remove project (deletes all its sessions)",
      danger: true,
      shortcut: kb("remove_project"),
      action: () => {
        void confirmDialog(
          `Remove project "${group.name}" and all ${group.sessions.length} session(s)?\nWorktrees and tmux sessions will be removed.`,
          "Remove",
        ).then((ok) => {
          if (ok) void lifecycle("remove_project", group.id);
        });
      },
    },
  ];
}

export async function deleteMergedSessions(): Promise<void> {
  let merged: [string, string][];
  try {
    merged = await invoke<[string, string][]>("merged_pr_sessions");
  } catch (e) {
    toast(`failed to list merged sessions: ${e}`, "error");
    return;
  }
  if (!merged.length) {
    toast("No sessions with merged PRs");
    return;
  }
  const preview = merged
    .slice(0, 8)
    .map(([, branch]) => `  • ${branch}`)
    .join("\n");
  const more = merged.length > 8 ? `\n  … and ${merged.length - 8} more` : "";
  const ok = await confirmDialog(
    `Delete ${merged.length} session(s) with merged PRs?\n\n${preview}${more}\n\nThis removes their worktrees and branches.`,
    "Delete all",
  );
  if (!ok) return;
  for (const [id] of merged) {
    const row = findSession(id);
    if (row) {
      deleteSession(row);
    } else {
      await invoke("delete_session", { id }).catch((e) => toast(`delete failed: ${e}`, "error"));
    }
  }
}

export function sidebarMenuItems(): MenuItem[] {
  return [
    {
      label: "Add project…",
      shortcut: kb("new_project"),
      action: () => {
        setTopInput("add");
        requestRender("sidebar");
      },
    },
    {
      label: "Scan directory for repos…",
      shortcut: kb("scan_directory"),
      action: () => {
        setTopInput("scan");
        requestRender("sidebar");
      },
    },
    "separator",
    { label: "Settings…", shortcut: kb("show_settings"), action: () => void openSettings() },
    { label: "Help", shortcut: kb("show_help"), action: toggleHelp },
    "separator",
    {
      label: "Delete merged-PR sessions…",
      danger: true,
      shortcut: kb("delete_merged_pr_sessions"),
      action: () => void deleteMergedSessions(),
    },
  ];
}

/** Project list for the sidebar "New session…" picker. Sourced from `groups`,
 *  so it includes projects with no sessions — the one path to create a session
 *  for them in section views, where sessionless projects have no sub-header. */
