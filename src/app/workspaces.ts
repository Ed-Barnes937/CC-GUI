// Workspaces, as the GUI sees them: which one is active, what "in a workspace"
// means, and the rules a name must pass.
//
// A workspace is a label on a project (`ProjectGroup.workspace`, null = the
// built-in Main). The backend sends the merged list (Main first, then the
// definitions, then any tag no definition names); everything here reads that
// list rather than recomputing it. The active workspace is the GUI's own
// ("last used" is per client upstream), kept in localStorage, and switching it
// is a hard filter applied once, in app/store.ts.
//
// Pure apart from localStorage: no Tauri, no DOM, so it's unit-tested on its
// own and safe to import from anywhere (the theme layer included). Startup
// resolution is deliberately NOT here -- the backend runs upstream's
// `resolve_startup_workspace`, so the GUI and the TUI can't disagree.

import type { WorkspaceEntry } from "./types";

/** Longest accepted workspace name, in characters (protocol's limit). */
export const MAX_WORKSPACE_NAME_CHARS = 40;
const RESERVED = ["last", "main"];

/** The key Main's per-workspace GUI state is stored under. A NUL can't be in a
 *  workspace name (control characters are refused), so no user workspace can
 *  take it -- like core's reserved Main key. */
export const MAIN_KEY = "\u0000main";

/** The storage key for a workspace's GUI-owned state (view memory, theme). */
export function workspaceKey(name: string | null): string {
  return name ?? MAIN_KEY;
}

// ------------------------------------------------------------ the rules

/** Whether a project tagged `workspace` belongs to `active` (null = Main on
 *  both sides). viewmodel's `in_workspace`. */
export function inWorkspace(group: { workspace: string | null }, active: string | null): boolean {
  return (group.workspace ?? null) === active;
}

/** How many of `groups` are in workspace `name`. */
export function projectCount(groups: { workspace: string | null }[], name: string | null): number {
  return groups.filter((g) => inWorkspace(g, name)).length;
}

/** Workspace UI shows only once a second workspace exists (viewmodel's
 *  `workspaces_visible`), so today's chrome is unchanged until then. */
export function workspacesVisible(list: WorkspaceEntry[]): boolean {
  return list.length >= 2;
}

/** The workspace after (or before) `active`, wrapping. An `active` not in the
 *  list starts from Main. viewmodel's `cycle_workspace`. */
export function cycleWorkspace(list: WorkspaceEntry[], active: string | null, forward: boolean): string | null {
  if (!list.length) return null;
  const at = list.findIndex((w) => w.name === active);
  const idx = at === -1 ? 0 : at;
  const next = forward ? (idx + 1) % list.length : (idx + list.length - 1) % list.length;
  return list[next].name;
}

/** The list entry for `active`, falling back to Main (always first). */
export function activeEntry(list: WorkspaceEntry[], active: string | null): WorkspaceEntry {
  return list.find((w) => w.name === active) ?? list[0] ?? { name: null, label: "Main" };
}

/** The accelerator that jumps to the workspace at `index` (0-based), shown in
 *  the menu: Cmd+Shift+1..9, so only the first nine have one. */
export function workspaceShortcut(index: number): string | undefined {
  return index < 9 ? `⌘⇧${index + 1}` : undefined;
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

// Rust's `char::is_control`: the C0 and C1 control ranges.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Rust's `eq_ignore_ascii_case`: only ASCII letters fold.
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const eqi = (a: string, b: string) => asciiLower(a) === asciiLower(b);

/**
 * protocol's `validate_workspace_name` plus viewmodel's `workspace_name_taken`:
 * trimmed, non-empty, at most 40 characters, no control characters, not
 * `last`/`main`, and no case-insensitive clash with an existing workspace
 * (Main's label included). `except` is the workspace being renamed, which may
 * keep or re-case its own name. For inline feedback before invoking; the
 * backend re-validates, and the messages are its own.
 */
export function validateWorkspaceName(raw: string, existing: WorkspaceEntry[], except?: WorkspaceEntry): NameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, error: "workspace name must not be empty" };
  if ([...name].length > MAX_WORKSPACE_NAME_CHARS) {
    return { ok: false, error: `workspace name must be at most ${MAX_WORKSPACE_NAME_CHARS} characters` };
  }
  if (CONTROL.test(name)) return { ok: false, error: "workspace name must not contain control characters" };
  if (RESERVED.some((r) => eqi(r, name))) return { ok: false, error: `"${name}" is a reserved workspace name` };
  const taken = existing.some((w) => w.name !== except?.name && eqi(w.label, name));
  if (taken) return { ok: false, error: `workspace "${name}" is defined twice` };
  return { ok: true, name };
}

// ---------------------------------------------------------- the active one

const KEY_ACTIVE = "cc-active-workspace";

function readActive(): string | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY_ACTIVE) ?? "null");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

let active: string | null = readActive();

/** The active workspace (null = Main). Also the GUI's "last used", which the
 *  backend's startup resolution reads at boot. */
export function activeWorkspace(): string | null {
  return active;
}

/**
 * Why the active workspace changed: the user switched; boot applied the
 * startup choice; or the workspace vanished (deleted elsewhere) and the GUI
 * fell back to Main. Listeners that keep per-workspace state (view memory)
 * save the old one's only on a real switch -- at boot there's nothing on
 * screen yet to remember.
 */
export type WorkspaceChangeReason = "switch" | "startup" | "vanished";
export type WorkspaceChange = { prev: string | null; next: string | null; reason: WorkspaceChangeReason };

const listeners: ((change: WorkspaceChange) => void)[] = [];

/** Be told whenever the active workspace changes, after it has. */
export function onWorkspaceChange(cb: (change: WorkspaceChange) => void): void {
  listeners.push(cb);
}

/** Make `next` the active workspace, remember it, and tell the listeners. A
 *  no-op when it already is. */
export function setActiveWorkspace(next: string | null, reason: WorkspaceChangeReason = "switch"): void {
  if (next === active) return;
  const prev = active;
  active = next;
  try {
    localStorage.setItem(KEY_ACTIVE, JSON.stringify(next));
  } catch {
    // storage full or unavailable: the switch still applies for this run
  }
  for (const cb of listeners) cb({ prev, next, reason });
}

// Workspaces this client has just created, which a snapshot built before the
// create landed won't list yet. Held until a snapshot confirms them, so the
// switch that follows a create isn't undone by a stale push -- the same reason
// app/store.ts holds its optimistic masks until confirmed.
const expected = new Set<string>();

/** Treat `name` as existing until a snapshot lists it. */
export function expectWorkspace(name: string): void {
  expected.add(name);
}

/** The workspace to show for `wanted` given the merged `list`: itself while it
 *  exists (or is expected), else Main. viewmodel's `effective_workspace`. */
export function effectiveWorkspace(
  wanted: string | null,
  list: WorkspaceEntry[],
  pending: ReadonlySet<string> = expected,
): string | null {
  if (wanted === null) return null;
  return list.some((w) => w.name === wanted) || pending.has(wanted) ? wanted : null;
}

/** Run on every snapshot: drop expectations the list now confirms, and fall
 *  back to Main if the active workspace is gone (deleted from the TUI, say). */
export function reconcileActiveWorkspace(list: WorkspaceEntry[]): void {
  for (const name of [...expected]) if (list.some((w) => w.name === name)) expected.delete(name);
  const effective = effectiveWorkspace(active, list);
  if (effective !== active) setActiveWorkspace(effective, "vanished");
}

// ---------------------------------------------------------- view memory

/** What each workspace remembers across switches: the keyboard cursor's
 *  session and the active terminal tab (a tmux session name). */
export type ViewMemory = { selected: string | null; tab: string | null };

const KEY_VIEW = "cc-workspace-view";

function readViews(): Record<string, ViewMemory> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY_VIEW) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, ViewMemory>) : {};
  } catch {
    return {};
  }
}

let views: Record<string, ViewMemory> = readViews();

/** What workspace `name` last showed (nothing, if it was never left). */
export function viewMemory(name: string | null): ViewMemory {
  const m = views[workspaceKey(name)];
  return {
    selected: typeof m?.selected === "string" ? m.selected : null,
    tab: typeof m?.tab === "string" ? m.tab : null,
  };
}

/** Remember what workspace `name` is showing as it's left. */
export function rememberView(name: string | null, memory: ViewMemory): void {
  views = { ...views, [workspaceKey(name)]: memory };
  try {
    localStorage.setItem(KEY_VIEW, JSON.stringify(views));
  } catch {
    // best effort: memory still holds for this run
  }
}

/** Reset module state, re-reading localStorage. Tests only. */
export function resetWorkspacesForTest(): void {
  active = readActive();
  views = readViews();
  expected.clear();
  listeners.length = 0;
}
