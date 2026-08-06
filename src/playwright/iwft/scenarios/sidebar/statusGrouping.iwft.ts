import { test, expect } from "../../support/fixture.testHelper";
import { makeSession, makeSnapshot } from "../../network/seed.testHelper";
import type { Snapshot } from "../../network/types.testHelper";

// The GUI-only "Status" grouping: sessions bucketed into activity tiers
// (Needs you / Active / Parked). Tier membership only changes on meaningful
// events — never on the working ⇄ idle flicker — and the backend view mode is
// left untouched underneath.

/** One project with a session in every tier; `workingState` parameterizes the
 *  first session's agent_state so tests can flap or flip it via pushSnapshot. */
function tierSnapshot(workingState: string): Snapshot {
  return makeSnapshot({
    groups: [
      {
        id: "proj-1",
        name: "acme",
        repo_path: "/repos/acme",
        pull_blocked: null,
        sessions: [
          makeSession({ id: "sess-w", title: "working one", agent_state: workingState }),
          makeSession({ id: "sess-q", title: "waiting one", agent_state: "waitingforinput" }),
          makeSession({ id: "sess-d", title: "done one", unread: true }),
          makeSession({ id: "sess-s", title: "stopped one", status: "stopped" }),
          makeSession({
            id: "sess-h",
            title: "hibernating one",
            status: "stopped",
            hibernated: true,
          }),
        ],
      },
    ],
  });
}

test.describe("status grouping tiers", () => {
  test.use({ seed: { snapshot: tierSnapshot("working"), reviews: {} } });

  test("buckets rows into tiers and leaves the view mode untouched", async ({
    sidebar,
  }) => {
    await sidebar.setGrouping("Status");

    expect(await sidebar.activeGrouping()).toBe("Status");
    expect(await sidebar.renderedTierOf("waiting one")).toBe("Needs you");
    expect(await sidebar.renderedTierOf("done one")).toBe("Needs you");
    expect(await sidebar.renderedTierOf("working one")).toBe("Active");
    expect(await sidebar.renderedTierOf("stopped one")).toBe("Parked");
    expect(await sidebar.renderedTierOf("hibernating one")).toBe("Parked");
    // Status is GUI-only, layered over the view mode without changing it.
    expect(await sidebar.storedViewMode()).toBe("project");
  });

  test("a working ⇄ idle flap stays inside Active — the row doesn't move", async ({
    sidebar,
  }) => {
    await sidebar.setGrouping("Status");
    await sidebar.pushSnapshot(tierSnapshot("idle"));

    await expect(async () => {
      expect(await sidebar.statusLabel("working one")).toBe("Idle");
    }).toPass();
    expect(await sidebar.renderedTierOf("working one")).toBe("Active");
  });

  test("a turn ending moves the row into Needs you", async ({ sidebar }) => {
    await sidebar.setGrouping("Status");
    await sidebar.pushSnapshot(tierSnapshot("waitingforinput"));

    await expect(async () => {
      expect(await sidebar.renderedTierOf("working one")).toBe("Needs you");
    }).toPass();
  });

  test("switching back to Projects restores the underlying grouping", async ({ sidebar }) => {
    await sidebar.setGrouping("Status");
    await sidebar.setGrouping("Projects");

    expect(await sidebar.activeGrouping()).toBe("Projects");
    // Tier headers are gone; the rows sit under their project header again.
    await expect(sidebar.sectionHeader("Needs you")).toHaveCount(0);
    await expect(sidebar.sectionHeader("acme")).toBeVisible();
  });
});

test.describe("empty tiers are hidden", () => {
  // Default seed: a single running session — only Active has members.
  test("only tiers with sessions render a header", async ({ sidebar }) => {
    await sidebar.setGrouping("Status");

    expect(await sidebar.renderedTierOf("fix login bug")).toBe("Active");
    await expect(sidebar.sectionHeader("Needs you")).toHaveCount(0);
    await expect(sidebar.sectionHeader("Parked")).toHaveCount(0);
  });
});
