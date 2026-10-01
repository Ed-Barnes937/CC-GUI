// The simulator's workspace backend must behave like the real one (upstream
// protocol + core + viewmodel, and src-tauri/src/workspaces.rs), or every iwft
// that leans on it tests against a fiction. These cases mirror the Rust tests
// on both sides.

import { describe, expect, it } from "vitest";
import {
  WorkspaceBackend,
  mergeWorkspaces,
  validateLabel,
  validateName,
  type TaggedProject,
  type WorkspaceConfig,
} from "./workspaceBackend.testHelper";

function backend(config: WorkspaceConfig, tags: (string | null)[] = []) {
  const projects: TaggedProject[] = tags.map((workspace, i) => ({ id: `p${i}`, workspace }));
  return { ws: new WorkspaceBackend(config, () => projects), projects };
}

const names = (ws: WorkspaceBackend) => ws.merged().map((w) => w.name);
const fails = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e as string;
  }
  throw new Error("expected a rejection");
};

describe("naming rules", () => {
  it("trims, bounds and refuses control characters and reserved names", () => {
    expect(validateName("  Work ")).toBe("Work");
    expect(fails(() => validateName("   "))).toBe("workspace name must not be empty");
    expect(fails(() => validateName("x".repeat(41)))).toBe(
      "workspace name must be at most 40 characters",
    );
    expect(validateName("x".repeat(40))).toHaveLength(40);
    expect(fails(() => validateName("a\nb"))).toBe(
      "workspace name must not contain control characters",
    );
    for (const r of ["last", "Main", "MAIN"]) {
      expect(fails(() => validateName(r))).toBe(`"${r}" is a reserved workspace name`);
    }
    // Main's *label* may be "Main"; the reservation is for user names.
    expect(validateLabel("Main")).toBe("Main");
  });
});

describe("merged list", () => {
  it("is Main, then definitions in order, then undefined tags", () => {
    const merged = mergeWorkspaces({ defs: ["Work", "Play"], main: "Home", startup: "last" }, [
      "Lost",
      null,
      "Work",
      "Lost",
    ]);
    expect(merged).toEqual([
      { name: null, label: "Home" },
      { name: "Work", label: "Work" },
      { name: "Play", label: "Play" },
      { name: "Lost", label: "Lost" },
    ]);
    expect(backend({}).ws.merged()).toEqual([{ name: null, label: "Main" }]);
  });
});

describe("create", () => {
  it("appends the trimmed name and returns it", () => {
    const { ws } = backend({ defs: ["Work"] });
    expect(ws.create("  OSS ")).toBe("OSS");
    expect(ws.state().defs).toEqual(["Work", "OSS"]);
  });

  it("defines a tag-only workspace in place", () => {
    const { ws } = backend({ defs: ["Work"] }, ["Lost"]);
    ws.create("OSS");
    expect(ws.state().defs).toEqual(["Work", "Lost", "OSS"]);
  });

  it("refuses a name taken by a workspace, a tag or Main's label", () => {
    const { ws } = backend({ defs: ["Work"], main: "Home" }, ["Lost"]);
    expect(fails(() => ws.create("work"))).toBe('workspace "work" is defined twice');
    expect(fails(() => ws.create(" HOME "))).toBe('workspace "HOME" is defined twice');
    expect(fails(() => ws.create("lost"))).toBe('workspace "lost" is defined twice');
    expect(ws.state().defs).toEqual(["Work"]);
  });
});

describe("reorder", () => {
  it("follows the names, keeping unmentioned ones and ignoring unknown ones", () => {
    const { ws } = backend({ defs: ["A", "B", "C", "D"] });
    ws.reorder(["C", "Gone", "A", "C"]);
    expect(ws.state().defs).toEqual(["C", "A", "B", "D"]);
  });

  it("drops a tag that clashes with a definition rather than failing", () => {
    const { ws } = backend({ defs: ["Work"] }, ["work"]);
    ws.reorder(["work", "Work"]);
    expect(ws.state().defs).toEqual(["Work"]);
  });
});

describe("rename", () => {
  it("moves the definition, a startup pin and every tag", () => {
    const { ws, projects } = backend({ defs: ["Work", "Play"], startup: "Work" }, [
      "Work",
      null,
      "Work",
    ]);
    expect(ws.rename("Work", " Job ")).toBe(true);
    expect(ws.state()).toEqual({ defs: ["Job", "Play"], main: null, startup: "Job" });
    expect(projects.map((p) => p.workspace)).toEqual(["Job", null, "Job"]);
  });

  it("refuses a clash but allows re-casing itself", () => {
    const { ws } = backend({ defs: ["Work", "Play"], main: "Home" });
    expect(fails(() => ws.rename("Work", "play"))).toBe('workspace "play" is defined twice');
    expect(fails(() => ws.rename("Work", "home"))).toBe('workspace "home" is defined twice');
    expect(ws.rename("Work", "WORK")).toBe(true);
    expect(ws.state().defs).toEqual(["WORK", "Play"]);
  });

  it("defines the new name for tags that had no definition", () => {
    const { ws, projects } = backend({}, ["Lost"]);
    expect(ws.rename("Lost", "Found")).toBe(true);
    expect(ws.state().defs).toEqual(["Found"]);
    expect(projects[0].workspace).toBe("Found");
  });

  it("is a no-op for an unknown workspace", () => {
    const { ws } = backend({ defs: ["Work"] });
    expect(ws.rename("Gone", "New")).toBe(false);
    expect(ws.state().defs).toEqual(["Work"]);
  });
});

describe("delete", () => {
  it("drops the definition, unpins startup and moves projects to Main", () => {
    const { ws, projects } = backend({ defs: ["Work", "OSS"], startup: "Work" }, [
      "Work",
      "OSS",
    ]);
    expect(ws.delete("Work")).toBe(true);
    expect(ws.state()).toEqual({ defs: ["OSS"], main: null, startup: "main" });
    expect(projects.map((p) => p.workspace)).toEqual([null, "OSS"]);
    expect(ws.delete("Work")).toBe(false);
  });

  it("leaves a non-pinned startup choice alone", () => {
    const { ws } = backend({ defs: ["Work"], startup: "last" });
    ws.delete("Work");
    expect(ws.state().startup).toBe("last");
  });
});

describe("move a project", () => {
  it("defines an unknown workspace on the way, and null moves it to Main", () => {
    const { ws, projects } = backend({ defs: ["Work"] }, [null]);
    ws.setProjectWorkspace("p0", " OSS ");
    expect(projects[0].workspace).toBe("OSS");
    expect(ws.state().defs).toEqual(["Work", "OSS"]);
    ws.setProjectWorkspace("p0", null);
    expect(projects[0].workspace).toBe(null);
  });

  it("refuses an invalid name or an unknown project", () => {
    const { ws } = backend({}, [null]);
    expect(fails(() => ws.setProjectWorkspace("p0", "main"))).toBe(
      '"main" is a reserved workspace name',
    );
    expect(fails(() => ws.setProjectWorkspace("nope", "Work"))).toBe(
      "Session error: Project not found: nope",
    );
    expect(ws.state().defs).toEqual([]);
  });
});

describe("Main label and startup", () => {
  it("relabels Main, refusing a clash with a name", () => {
    const { ws } = backend({ defs: ["Work"] });
    ws.setMainLabel(" Home ");
    expect(ws.merged()[0]).toEqual({ name: null, label: "Home" });
    // Upstream names the definition the label collides with.
    expect(fails(() => ws.setMainLabel("work"))).toBe('workspace "Work" is defined twice');
    expect(fails(() => ws.setMainLabel(""))).toBe("workspace name must not be empty");
    expect(ws.state().main).toBe("Home");
  });

  it("stores the three startup forms, defining a pinned tag-only name", () => {
    const { ws } = backend({ defs: ["Work"] }, ["Lost"]);
    ws.setStartup("MAIN");
    expect(ws.startup()).toBe("main");
    ws.setStartup("Work");
    expect(ws.startup()).toBe("Work");
    ws.setStartup("Lost");
    expect(ws.state()).toEqual({ defs: ["Work", "Lost"], main: null, startup: "Lost" });
    ws.setStartup("last");
    expect(ws.startup()).toBe("last");
    expect(fails(() => ws.setStartup("a\tb"))).toBe(
      "workspace name must not contain control characters",
    );
  });

  it("resolves the startup workspace, falling back to Main", () => {
    const { ws } = backend({ defs: ["Work"] });
    expect(ws.resolveStartup("Work")).toBe("Work");
    expect(ws.resolveStartup("Gone")).toBe(null);
    expect(ws.resolveStartup(null)).toBe(null);
    ws.setStartup("main");
    expect(ws.resolveStartup("Work")).toBe(null);
    ws.setStartup("Work");
    expect(ws.resolveStartup(null)).toBe("Work");
  });

  it("serialises the config fields as get_config does", () => {
    const { ws } = backend({ defs: ["Work"], main: "Home", startup: "Work" });
    expect(ws.configFields()).toEqual({
      workspaces: [{ name: "Work" }],
      main_workspace: { name: "Home" },
      startup_workspace: "Work",
    });
    expect(names(backend({}).ws)).toEqual([null]);
  });
});
