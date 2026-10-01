// The TauriSimulator's workspace backend: definitions, Main's label, the
// startup choice and project tags, with the same rules and the same error text
// as the real stack (claude-commander-protocol's naming rules, core's
// CommanderService workspace methods, viewmodel's merge and startup resolution,
// and src-tauri/src/workspaces.rs's request builders). Pure, so it is unit-tested
// on its own (workspaceBackend.test.ts) as well as driven through the fake.
//
// Errors are thrown as plain strings, as a rejected Tauri invoke delivers them.
// The backend's `workspace_err` strips core's "Invalid session name" wrapper, so
// what arrives is the bare rule (e.g. `workspace name must not be empty`).

import type { WorkspaceEntry } from "../../../app/types";

/** Longest accepted workspace name / label, in characters. */
export const MAX_WORKSPACE_NAME_CHARS = 40;
const RESERVED = ["last", "main"];
const MAIN_LABEL = "Main";

/** A project as the workspace backend sees it: an id and a mutable tag. */
export type TaggedProject = { id: string; workspace?: string | null };

/** The shared-config side of workspaces, as a seed describes it. */
export type WorkspaceConfig = {
  /** `[[workspaces]]` names, in display order. */
  defs?: string[];
  /** `[main_workspace]` label; absent/null = the default "Main". */
  main?: string | null;
  /** `startup_workspace`: "last" (default), "main" or a workspace name. */
  startup?: string;
};

/** A `set_workspace_defs` body: `main`/`startup` undefined = leave alone. */
type SetRequest = { workspaces: string[]; main?: string; startup?: string };

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Rust's `char::is_control`: the C0 and C1 control ranges.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** protocol `validate_workspace_label`: trimmed, non-empty, bounded, printable. */
export function validateLabel(raw: string): string {
  const name = raw.trim();
  if (!name) throw "workspace name must not be empty";
  if ([...name].length > MAX_WORKSPACE_NAME_CHARS) {
    throw `workspace name must be at most ${MAX_WORKSPACE_NAME_CHARS} characters`;
  }
  if (CONTROL.test(name)) throw "workspace name must not contain control characters";
  return name;
}

/** protocol `validate_workspace_name`: a valid label that isn't reserved. */
export function validateName(raw: string): string {
  const name = validateLabel(raw);
  if (RESERVED.some((r) => eqi(r, name))) throw `"${name}" is a reserved workspace name`;
  return name;
}

const duplicate = (name: string) => `workspace "${name}" is defined twice`;

/** protocol `StartupWorkspace`'s string form: "last"/"main" case-insensitively,
 *  else a name (kept as given; validation trims it). */
function parseStartup(value: string): string {
  if (eqi(value, "last")) return "last";
  if (eqi(value, "main")) return "main";
  return value;
}

/** viewmodel `merge_workspace_sources` for one server: Main first, then the
 *  definitions in order, then tags no definition names, in project order. */
export function mergeWorkspaces(
  config: Required<WorkspaceConfig>,
  projectTags: (string | null | undefined)[],
): WorkspaceEntry[] {
  const merged: WorkspaceEntry[] = [{ name: null, label: config.main ?? MAIN_LABEL }];
  for (const name of [...config.defs, ...projectTags]) {
    if (name == null) continue;
    if (!merged.some((w) => w.name === name)) merged.push({ name, label: name });
  }
  return merged;
}

/** viewmodel `workspace_name_taken`: a label clash, trimmed, case-insensitive. */
function nameTaken(merged: WorkspaceEntry[], name: string): boolean {
  const n = name.trim();
  return merged.some((w) => eqi(w.label, n));
}

/** viewmodel `definitions_for_server`: keep every name the server defines,
 *  drop others that clash with Main's label, its names or one already kept. */
function definitionsForServer(wanted: string[], own: string[], mainLabel: string | null): string[] {
  const claimed: string[] = [...(mainLabel !== null ? [mainLabel] : []), ...own];
  const out: string[] = [];
  for (const name of wanted) {
    if (own.includes(name)) {
      out.push(name);
      continue;
    }
    if (claimed.some((c) => eqi(c, name))) continue;
    claimed.push(name);
    out.push(name);
  }
  return out;
}

export class WorkspaceBackend {
  private config: Required<WorkspaceConfig>;

  constructor(
    seed: WorkspaceConfig | undefined,
    /** The fake's live projects (mutable: rename/delete/move re-tag them). */
    private readonly projects: () => TaggedProject[],
  ) {
    this.config = {
      defs: [...(seed?.defs ?? [])],
      main: seed?.main ?? null,
      startup: parseStartup(seed?.startup ?? "last"),
    };
  }

  // ----- state, for the snapshot, get_config and test assertions -----

  /** The stored config fields (a copy). */
  state(): Required<WorkspaceConfig> {
    return { ...this.config, defs: [...this.config.defs] };
  }

  /** The snapshot's `workspaces`. */
  merged(): WorkspaceEntry[] {
    return mergeWorkspaces(
      this.config,
      this.projects().map((p) => p.workspace),
    );
  }

  /** The snapshot's `startup_workspace`. */
  startup(): string {
    return this.config.startup;
  }

  /** The workspace fields as `get_config` serialises them. */
  configFields(): Record<string, unknown> {
    return {
      workspaces: this.config.defs.map((name) => ({ name })),
      main_workspace: this.config.main === null ? null : { name: this.config.main },
      startup_workspace: this.config.startup,
    };
  }

  // ----- core's validated wholesale replace -----

  /** core `set_workspace_defs`: validated against the stored Main label when
   *  `main` is absent; nothing is written for a refused request. */
  private setDefs(req: SetRequest): void {
    const stored = this.config.main;
    const storedValid = stored !== null && isValidLabel(stored) ? stored : null;
    const workspaces = req.workspaces.map(validateName);
    const main = req.main !== undefined ? validateLabel(req.main) : storedValid;
    const seen: string[] = main !== null ? [main] : [];
    for (const name of workspaces) {
      if (seen.some((s) => eqi(s, name))) throw duplicate(name);
      seen.push(name);
    }
    let startup = req.startup;
    if (startup !== undefined && isPinned(startup)) {
      startup = startup.trim();
      if (!workspaces.includes(startup)) {
        throw `startup workspace "${startup}" is not a defined workspace`;
      }
    }
    this.config.defs = workspaces;
    if (req.main !== undefined) this.config.main = main;
    if (startup !== undefined) this.config.startup = startup;
  }

  private ensureDefined(name: string): void {
    if (!this.config.defs.includes(name)) this.config.defs.push(name);
  }

  private validTag(workspace: string | null | undefined): string | null {
    return workspace == null ? null : validateName(workspace);
  }

  private retag(from: string, to: string | null): number {
    let moved = 0;
    for (const p of this.projects()) {
      if (p.workspace === from) {
        p.workspace = to;
        moved++;
      }
    }
    return moved;
  }

  private namedMerged(): string[] {
    return this.merged().flatMap((w) => (w.name === null ? [] : [w.name]));
  }

  private defsFor(wanted: string[]): string[] {
    return definitionsForServer(wanted, this.config.defs, this.config.main);
  }

  // ----- the commands (src-tauri/src/workspaces.rs) -----

  /** set_project_workspace: unknown names are defined on the way. */
  setProjectWorkspace(projectId: string, workspace: string | null): void {
    const tag = this.validTag(workspace);
    const project = this.projects().find((p) => p.id === projectId);
    if (!project) throw `Session error: Project not found: ${projectId}`;
    if (tag !== null) this.ensureDefined(tag);
    project.workspace = tag;
  }

  /** The tag for a project about to be added (add_project / scan_directory),
   *  defining it on the way. */
  prepareNewProject(workspace: string | null | undefined): string | null {
    const tag = this.validTag(workspace);
    if (tag !== null) this.ensureDefined(tag);
    return tag;
  }

  /** create_workspace: appended after the merged list; returns the stored name. */
  create(raw: string): string {
    const name = validateName(raw);
    if (nameTaken(this.merged(), name)) throw duplicate(name);
    this.setDefs({ workspaces: this.defsFor([...this.namedMerged(), name]) });
    return name;
  }

  /** reorder_workspaces: `names` first (unknown ones ignored), then the rest. */
  reorder(names: string[]): void {
    const current = this.namedMerged();
    const wanted: string[] = [];
    for (const n of names) if (current.includes(n) && !wanted.includes(n)) wanted.push(n);
    for (const n of current) if (!wanted.includes(n)) wanted.push(n);
    this.setDefs({ workspaces: this.defsFor(wanted) });
  }

  /** core `rename_workspace`: the definition, a startup pin, every tag.
   *  `false` when nothing had the name. */
  rename(from: string, rawTo: string): boolean {
    const to = validateName(rawTo);
    const main = this.config.main;
    if (
      (main !== null && eqi(main, to)) ||
      this.config.defs.some((d) => d !== from && eqi(d, to))
    ) {
      throw duplicate(to);
    }
    const i = this.config.defs.indexOf(from);
    const renamedDef = i >= 0;
    if (renamedDef) {
      this.config.defs[i] = to;
      if (isPinned(this.config.startup) && this.config.startup === from) this.config.startup = to;
    }
    const moved = this.retag(from, to);
    if (!renamedDef && moved === 0) return false;
    if (!renamedDef) this.ensureDefined(to);
    return true;
  }

  /** core `delete_workspace`: drops the definition (a startup pin becomes
   *  Main) and moves its projects to Main. `false` when nothing had the name. */
  delete(name: string): boolean {
    const before = this.config.defs.length;
    this.config.defs = this.config.defs.filter((d) => d !== name);
    // Only a pin on a *name* unpins ("last"/"main" are never names).
    if (isPinned(this.config.startup) && this.config.startup === name) this.config.startup = "main";
    const removed = this.config.defs.length !== before;
    const moved = this.retag(name, null);
    return removed || moved > 0;
  }

  /** set_main_workspace_label. */
  setMainLabel(label: string): void {
    this.setDefs({ workspaces: [...this.config.defs], main: label });
  }

  /** set_startup_workspace: a pinned name gets a definition if it lacks one. */
  setStartup(value: string): void {
    const startup = parseStartup(value);
    const workspaces = [...this.config.defs];
    if (isPinned(startup)) {
      const name = startup.trim();
      if (!workspaces.includes(name)) workspaces.push(name);
    }
    this.setDefs({ workspaces, startup });
  }

  /** viewmodel `resolve_startup_workspace`: last → `last`, main → Main, a name
   *  → itself; anything no longer in the merged list → Main (null). */
  resolveStartup(last: string | null): string | null {
    const s = this.config.startup;
    const requested = s === "main" ? null : s === "last" ? last : s;
    if (requested === null) return null;
    return this.merged().some((w) => w.name === requested) ? requested : null;
  }
}

/** Whether a stored startup choice pins a named workspace. */
function isPinned(startup: string): boolean {
  return startup !== "last" && startup !== "main";
}

function isValidLabel(raw: string): boolean {
  try {
    validateLabel(raw);
    return true;
  } catch {
    return false;
  }
}
