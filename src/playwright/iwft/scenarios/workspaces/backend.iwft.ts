import type { Page } from "@playwright/test";
import { test, expect } from "../../support/fixture.testHelper";
import { workspacesSeed } from "../../network/seed.testHelper";
import type { AppSnapshot } from "../../network/types.testHelper";

// The workspace command surface through the real IPC path: the app boots
// against the fake, and these drive the same invoke() the frontend will, so a
// command name, an argument name or a snapshot field that drifts from the
// backend fails here before any UI is built on it. (No UI yet: this layer only
// adds the plumbing.)

test.use({ seed: workspacesSeed() });

function invoke<T>(page: Page, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([c, a]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    [cmd, args] as const,
  ) as Promise<T>;
}

/** The rejection an invoke delivers (the backend's error string). */
async function rejection(page: Page, cmd: string, args: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    async ([c, a]) => {
      try {
        await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke(c, a);
        return "resolved";
      } catch (e) {
        return String(e);
      }
    },
    [cmd, args] as const,
  );
}

const tags = (snap: AppSnapshot) => Object.fromEntries(snap.groups.map((g) => [g.name, g.workspace]));

test("the snapshot carries the merged workspaces, startup choice and project tags", async ({
  sidebar,
}) => {
  const snap = await invoke<AppSnapshot>(sidebar.page, "get_groups");
  expect(snap.workspaces).toEqual([
    { name: null, label: "Main" },
    { name: "Work", label: "Work" },
    { name: "OSS", label: "OSS" },
  ]);
  expect(snap.startup_workspace).toBe("last");
  expect(tags(snap)).toEqual({
    acme: null,
    "atlas-api": "Work",
    "web-app": "Work",
    dotfiles: "OSS",
  });
});

test("workspace edits land in the next snapshot", async ({ sidebar }) => {
  const page = sidebar.page;
  expect(await invoke(page, "create_workspace", { name: "  Side " })).toBe("Side");
  // Moving into an unknown workspace defines it on the way.
  await invoke(page, "set_project_workspace", { projectId: "proj-1", workspace: "Client" });
  expect(await invoke(page, "rename_workspace", { from: "Work", to: "Job" })).toBe(true);
  await invoke(page, "set_startup_workspace", { value: "Job" });
  expect(await invoke(page, "delete_workspace", { name: "OSS" })).toBe(true);
  await invoke(page, "reorder_workspaces", { names: ["Client", "Job"] });
  await invoke(page, "set_main_workspace_label", { label: "Home" });

  const snap = await invoke<AppSnapshot>(page, "get_groups");
  expect(snap.workspaces.map((w) => w.label)).toEqual(["Home", "Client", "Job", "Side"]);
  expect(snap.startup_workspace).toBe("Job");
  expect(tags(snap)).toEqual({
    acme: "Client",
    "atlas-api": "Job",
    "web-app": "Job",
    dotfiles: null,
  });
  expect(await invoke(page, "resolve_startup_workspace", { last: null })).toBe("Job");
});

test("a refused name rejects with the backend's reason and changes nothing", async ({
  sidebar,
}) => {
  const page = sidebar.page;
  expect(await rejection(page, "create_workspace", { name: "work" })).toBe(
    'workspace "work" is defined twice',
  );
  expect(await rejection(page, "rename_workspace", { from: "OSS", to: "last" })).toBe(
    '"last" is a reserved workspace name',
  );
  const snap = await invoke<AppSnapshot>(page, "get_groups");
  expect(snap.workspaces.map((w) => w.name)).toEqual([null, "Work", "OSS"]);
});

test("new projects land in the workspace they're added to", async ({ sidebar }) => {
  await invoke(sidebar.page, "add_project", { path: "/repos/new-thing", workspace: "OSS" });
  const projects = await sidebar.page.evaluate(() =>
    (
      window as unknown as {
        __CC_SIM__: { getProjects(): { name: string; workspace: string | null }[] };
      }
    ).__CC_SIM__.getProjects(),
  );
  expect(projects.find((p) => p.name === "new-thing")?.workspace).toBe("OSS");
});

test("a settings save from a stale form keeps the current workspace fields", async ({
  sidebar,
}) => {
  const page = sidebar.page;
  // The form loaded the config before these workspace edits landed.
  const form = await invoke<Record<string, unknown>>(page, "get_config");
  await invoke(page, "create_workspace", { name: "Side" });
  await invoke(page, "set_startup_workspace", { value: "Side" });
  await invoke(page, "save_config", { config: { ...form, ai_summary_enabled: false } });

  const config = await invoke<Record<string, unknown>>(page, "get_config");
  expect(config.workspaces).toEqual([{ name: "Work" }, { name: "OSS" }, { name: "Side" }]);
  expect(config.startup_workspace).toBe("Side");
  expect(config.ai_summary_enabled).toBe(false);
});
