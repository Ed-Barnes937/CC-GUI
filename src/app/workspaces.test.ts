import { describe, it, expect, beforeEach } from "vitest";
import type { WorkspaceEntry } from "./types";
import {
  MAIN_KEY,
  activeEntry,
  activeWorkspace,
  cycleWorkspace,
  effectiveWorkspace,
  expectWorkspace,
  inWorkspace,
  onWorkspaceChange,
  projectCount,
  reconcileActiveWorkspace,
  registerWorkspaceState,
  rememberView,
  resetWorkspacesForTest,
  setActiveWorkspace,
  validateWorkspaceLabel,
  validateWorkspaceName,
  viewMemory,
  workspaceDeleted,
  workspaceRenamed,
  workspaceKey,
  workspaceShortcut,
  workspacesVisible,
  type WorkspaceChange,
  type WorkspaceKeyedState,
} from "./workspaces";

const MAIN: WorkspaceEntry = { name: null, label: "Main" };
const WORK: WorkspaceEntry = { name: "Work", label: "Work" };
const OSS: WorkspaceEntry = { name: "OSS", label: "OSS" };
const LIST = [MAIN, WORK, OSS];

beforeEach(() => {
  localStorage.clear();
  resetWorkspacesForTest();
});

describe("membership", () => {
  it("matches a project's tag to the active workspace, null being Main", () => {
    expect(inWorkspace({ workspace: null }, null)).toBe(true);
    expect(inWorkspace({ workspace: "Work" }, "Work")).toBe(true);
    expect(inWorkspace({ workspace: "Work" }, null)).toBe(false);
    expect(inWorkspace({ workspace: null }, "Work")).toBe(false);
    // Tags are exact names: no case folding.
    expect(inWorkspace({ workspace: "work" }, "Work")).toBe(false);
  });

  it("counts a workspace's projects", () => {
    const groups = [{ workspace: null }, { workspace: "Work" }, { workspace: "Work" }];
    expect(projectCount(groups, null)).toBe(1);
    expect(projectCount(groups, "Work")).toBe(2);
    expect(projectCount(groups, "OSS")).toBe(0);
  });

  it("shows workspace UI only once a second workspace exists", () => {
    expect(workspacesVisible([MAIN])).toBe(false);
    expect(workspacesVisible([MAIN, WORK])).toBe(true);
  });
});

describe("navigation", () => {
  it("cycles forward and back, wrapping, as upstream's cycle_workspace", () => {
    expect(cycleWorkspace(LIST, null, true)).toBe("Work");
    expect(cycleWorkspace(LIST, "OSS", true)).toBe(null);
    expect(cycleWorkspace(LIST, null, false)).toBe("OSS");
    expect(cycleWorkspace(LIST, "Work", false)).toBe(null);
  });

  it("cycles from Main when the active workspace isn't listed", () => {
    expect(cycleWorkspace(LIST, "Gone", true)).toBe("Work");
  });

  it("gives the first nine workspaces a Cmd+Shift+N shortcut", () => {
    expect(workspaceShortcut(0)).toBe("⌘⇧1");
    expect(workspaceShortcut(8)).toBe("⌘⇧9");
    expect(workspaceShortcut(9)).toBeUndefined();
  });

  it("finds the active entry, falling back to Main", () => {
    expect(activeEntry(LIST, "OSS")).toBe(OSS);
    expect(activeEntry([{ name: null, label: "Home" }, WORK], "Gone").label).toBe("Home");
  });
});

describe("validateWorkspaceName", () => {
  const ok = (raw: string, existing = LIST) => validateWorkspaceName(raw, existing);

  it("accepts and trims a fresh name", () => {
    expect(ok("  Side  ")).toEqual({ ok: true, name: "Side" });
  });

  it("refuses empty and whitespace-only names", () => {
    expect(ok("   ")).toEqual({ ok: false, error: "workspace name must not be empty" });
  });

  it("counts characters, not UTF-16 units, against the 40 limit", () => {
    expect(ok("a".repeat(40)).ok).toBe(true);
    expect(ok("a".repeat(41))).toEqual({ ok: false, error: "workspace name must be at most 40 characters" });
    // 40 astral characters are 80 UTF-16 units but still 40 characters.
    expect(ok("😀".repeat(40)).ok).toBe(true);
  });

  it("refuses control characters", () => {
    expect(ok("a\tb")).toEqual({ ok: false, error: "workspace name must not contain control characters" });
    expect(ok("a\u0085b").ok).toBe(false);
  });

  it("refuses the reserved words, case-insensitively", () => {
    expect(ok("MAIN")).toEqual({ ok: false, error: '"MAIN" is a reserved workspace name' });
    expect(ok("Last").ok).toBe(false);
  });

  it("refuses an ASCII case-insensitive clash, Main's label included", () => {
    expect(ok("work")).toEqual({ ok: false, error: 'workspace "work" is defined twice' });
    expect(ok("home", [{ name: null, label: "Home" }])).toEqual({
      ok: false,
      error: 'workspace "home" is defined twice',
    });
  });

  it("folds only ASCII case, as Rust's eq_ignore_ascii_case does", () => {
    expect(ok("ÉTÉ", [MAIN, { name: "été", label: "été" }]).ok).toBe(true);
  });

  it("lets a renamed workspace keep or re-case its own name", () => {
    expect(validateWorkspaceName("work", LIST, WORK)).toEqual({ ok: true, name: "work" });
    expect(validateWorkspaceName("oss", LIST, WORK).ok).toBe(false);
  });
});

describe("validateWorkspaceLabel", () => {
  it("accepts and trims a label, the default word Main included", () => {
    expect(validateWorkspaceLabel("  Home ", LIST)).toEqual({ ok: true, name: "Home" });
    expect(validateWorkspaceLabel("Main", LIST)).toEqual({ ok: true, name: "Main" });
    expect(validateWorkspaceLabel("last", LIST).ok).toBe(true);
  });

  it("applies the label rules", () => {
    expect(validateWorkspaceLabel(" ", LIST)).toEqual({ ok: false, error: "workspace name must not be empty" });
    expect(validateWorkspaceLabel("a".repeat(41), LIST).ok).toBe(false);
    expect(validateWorkspaceLabel("a\nb", LIST).ok).toBe(false);
  });

  it("refuses a clash with a named workspace, naming it as the backend does", () => {
    expect(validateWorkspaceLabel("work", LIST)).toEqual({ ok: false, error: 'workspace "Work" is defined twice' });
  });
});

describe("the active workspace", () => {
  it("defaults to Main and persists a switch", () => {
    expect(activeWorkspace()).toBe(null);
    setActiveWorkspace("Work");
    expect(activeWorkspace()).toBe("Work");
    resetWorkspacesForTest(); // a relaunch re-reads storage
    expect(activeWorkspace()).toBe("Work");
  });

  it("keeps a workspace literally named like JSON apart from Main", () => {
    setActiveWorkspace("null");
    resetWorkspacesForTest();
    expect(activeWorkspace()).toBe("null");
  });

  it("tells listeners what changed and why, and stays quiet on a no-op", () => {
    const seen: WorkspaceChange[] = [];
    onWorkspaceChange((c) => seen.push(c));
    setActiveWorkspace("Work");
    setActiveWorkspace("Work");
    setActiveWorkspace(null, "startup");
    expect(seen).toEqual([
      { prev: null, next: "Work", reason: "switch" },
      { prev: "Work", next: null, reason: "startup" },
    ]);
  });

  it("survives unreadable storage", () => {
    localStorage.setItem("cc-active-workspace", "{not json");
    resetWorkspacesForTest();
    expect(activeWorkspace()).toBe(null);
  });
});

describe("reconciliation", () => {
  it("keeps a workspace that still exists", () => {
    expect(effectiveWorkspace("OSS", LIST, new Set())).toBe("OSS");
    expect(effectiveWorkspace(null, LIST, new Set())).toBe(null);
  });

  it("falls back to Main when the active workspace vanishes", () => {
    const seen: WorkspaceChange[] = [];
    setActiveWorkspace("OSS");
    onWorkspaceChange((c) => seen.push(c));
    reconcileActiveWorkspace([MAIN, WORK]);
    expect(activeWorkspace()).toBe(null);
    expect(seen).toEqual([{ prev: "OSS", next: null, reason: "vanished" }]);
  });

  it("holds a just-created workspace until a snapshot lists it", () => {
    expectWorkspace("Side");
    setActiveWorkspace("Side");
    reconcileActiveWorkspace(LIST); // a stale snapshot, from before the create
    expect(activeWorkspace()).toBe("Side");
    reconcileActiveWorkspace([...LIST, { name: "Side", label: "Side" }]); // confirmed
    reconcileActiveWorkspace(LIST); // and now it really has gone
    expect(activeWorkspace()).toBe(null);
  });
});

describe("view memory", () => {
  it("remembers each workspace's cursor and tab, Main under its reserved key", () => {
    rememberView(null, { selected: "s1", tab: "cc-s1" });
    rememberView("Work", { selected: null, tab: "cc-w1" });
    resetWorkspacesForTest();
    expect(viewMemory(null)).toEqual({ selected: "s1", tab: "cc-s1" });
    expect(viewMemory("Work")).toEqual({ selected: null, tab: "cc-w1" });
    expect(viewMemory("OSS")).toEqual({ selected: null, tab: null });
    expect(Object.keys(JSON.parse(localStorage.getItem("cc-workspace-view")!))).toContain(MAIN_KEY);
  });

  it("keys Main apart from any user workspace", () => {
    expect(workspaceKey(null)).toBe(MAIN_KEY);
    expect(validateWorkspaceName(MAIN_KEY, LIST).ok).toBe(false);
  });

  it("ignores malformed stored entries", () => {
    localStorage.setItem("cc-workspace-view", JSON.stringify({ Work: { selected: 3, tab: null } }));
    resetWorkspacesForTest();
    expect(viewMemory("Work")).toEqual({ selected: null, tab: null });
  });
});

describe("state keyed by workspace", () => {
  /** A fake store, as a per-workspace theme map would be. */
  function fakeStore(initial: Record<string, string>): WorkspaceKeyedState & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      keys: () => Object.keys(data),
      move(from, to) {
        if (!(from in data)) return;
        data[to] = data[from];
        delete data[from];
      },
      drop(key) {
        delete data[key];
      },
    };
  }

  it("moves every store's entry on a rename, view memory included", () => {
    const themes = fakeStore({ OSS: "tokyo", Work: "latte" });
    registerWorkspaceState(themes);
    rememberView("OSS", { selected: "s9", tab: "cc-s9" });
    workspaceRenamed("OSS", "Open", false);
    expect(themes.data).toEqual({ Open: "tokyo", Work: "latte" });
    expect(viewMemory("Open")).toEqual({ selected: "s9", tab: "cc-s9" });
    expect(viewMemory("OSS")).toEqual({ selected: null, tab: null });
    resetWorkspacesForTest();
    expect(viewMemory("Open")).toEqual({ selected: "s9", tab: "cc-s9" }); // persisted
  });

  it("keeps a renamed active workspace active, through a stale snapshot too", () => {
    const seen: WorkspaceChange[] = [];
    setActiveWorkspace("OSS");
    onWorkspaceChange((c) => seen.push(c));
    workspaceRenamed("OSS", "Open", true);
    expect(activeWorkspace()).toBe("Open");
    expect(seen).toEqual([{ prev: "OSS", next: "Open", reason: "renamed" }]);
    reconcileActiveWorkspace(LIST); // built before the rename landed
    expect(activeWorkspace()).toBe("Open");
  });

  it("switches back to a renamed workspace a push had already left", () => {
    setActiveWorkspace("OSS");
    reconcileActiveWorkspace([MAIN, WORK, { name: "Open", label: "Open" }]); // the rename's push came first
    expect(activeWorkspace()).toBe(null);
    const seen: WorkspaceChange[] = [];
    onWorkspaceChange((c) => seen.push(c));
    workspaceRenamed("OSS", "Open", true);
    expect(seen).toEqual([{ prev: null, next: "Open", reason: "switch" }]);
  });

  it("leaves the active workspace alone when another one is renamed", () => {
    setActiveWorkspace("Work");
    workspaceRenamed("OSS", "Open", false);
    expect(activeWorkspace()).toBe("Work");
  });

  it("drops every store's entry on a delete", () => {
    const themes = fakeStore({ OSS: "tokyo", [MAIN_KEY]: "mocha" });
    registerWorkspaceState(themes);
    rememberView("OSS", { selected: "s9", tab: null });
    workspaceDeleted("OSS");
    expect(themes.data).toEqual({ [MAIN_KEY]: "mocha" });
    expect(viewMemory("OSS")).toEqual({ selected: null, tab: null });
  });

  it("prunes entries for workspaces gone elsewhere, but never Main's or an expected one's", () => {
    const themes = fakeStore({ OSS: "tokyo", Work: "latte", Side: "nord", [MAIN_KEY]: "mocha" });
    registerWorkspaceState(themes);
    rememberView("OSS", { selected: "s9", tab: null });
    rememberView(null, { selected: "s1", tab: null });
    expectWorkspace("Side");
    reconcileActiveWorkspace([MAIN, WORK]); // OSS renamed or deleted from the TUI
    expect(themes.data).toEqual({ Work: "latte", Side: "nord", [MAIN_KEY]: "mocha" });
    expect(viewMemory("OSS")).toEqual({ selected: null, tab: null });
    expect(viewMemory(null)).toEqual({ selected: "s1", tab: null });
  });
});
