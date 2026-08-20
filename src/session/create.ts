// Starting a new session, and picking the project to start it in.
//
// Three surfaces offer this: the terminal strip's "+" button, the sidebar's
// project menus, and the command palette. They share the dialog and the
// create/refresh sequence rather than each rolling their own.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "../toast";
import type { MenuItem } from "../menu";
import { createSessionDialog, rememberHarness } from "../harnessPicker";
import { refreshNow } from "../app/actions";
import { groups } from "../app/store";
import type { ProjectGroup } from "../app/types";

export function startSession(group: ProjectGroup, title: string, program: string | undefined): void {
  if (program) rememberHarness(group.repo_path, program);
  invoke("create_session", { projectPath: group.repo_path, title, program })
    .catch((err) => toast(`create failed: ${err}`, "error"))
    .finally(() => void refreshNow());
}

export function projectPickerItems(): MenuItem[] {
  if (!groups().length) {
    return [{ label: "No projects — add one first", action: () => {} }];
  }
  return groups().map((g) => ({
    label: g.name,
    action: () => void createSessionInProject(g),
  }));
}

export async function createSessionInProject(group: ProjectGroup): Promise<void> {
  const result = await createSessionDialog(`New session in ${group.name}`, group.repo_path);
  if (!result) return;
  startSession(group, result.title, result.program || undefined);
}

/** Persist the GUI-owned view mode and repaint. Section views fall back to
 *  "project" when no sections are configured (the backend used to reject them). */
