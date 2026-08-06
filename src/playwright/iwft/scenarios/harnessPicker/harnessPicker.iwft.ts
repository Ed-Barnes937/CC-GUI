import { test, expect } from "../../support/fixture.testHelper";
import { makeSession, makeSnapshot } from "../../network/seed.testHelper";

// The harness/program picker in the new-session flow. Drives the real frontend
// against the faked backend; assertions read resulting state (the program
// recorded on the created session's row, the rendered caret/menu) rather than
// which invokes fired.

test.describe("built-in fallback set (no configured programs)", () => {
  test("caret starts on the first built-in entry (Claude)", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await expect(sidebar.harnessCommand()).toHaveText("claude");
  });

  test("menu lists the built-in set in order, ticking the current entry", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    expect(await sidebar.harnessMenuItems()).toEqual([
      "Claude · claude",
      "Codex · codex",
      "OpenCode · opencode",
    ]);
    expect(await sidebar.tickedHarness()).toBe("claude");
  });

  test("the menu opens from the keyboard (↓ in the title field)", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenuViaKey();
    expect(await sidebar.isHarnessMenuOpen()).toBe(true);
  });

  test("selecting an entry closes the menu and updates the caret", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    await sidebar.selectHarness("opencode");
    expect(await sidebar.isHarnessMenuOpen()).toBe(false);
    await expect(sidebar.harnessCommand()).toHaveText("opencode");
  });

  test("type-title-then-Enter threads the selected harness into create_session", async ({
    sidebar,
  }) => {
    await sidebar.createWithHarness("acme", "try opencode", "opencode");
    await expect(async () => {
      expect(await sidebar.programOf("try opencode")).toBe("opencode");
    }).toPass();
  });

  test("the common case (no picker interaction) still launches the default harness", async ({
    sidebar,
  }) => {
    await sidebar.createSession("acme", "plain session");
    await expect(async () => {
      expect(await sidebar.programOf("plain session")).toBe("claude");
    }).toPass();
  });

  test("Escape cancels create without a picker interaction", async ({ sidebar }) => {
    await sidebar.cancelCreateSession("acme", "never made");
    expect((await sidebar.storedSessions()).map((s) => s.title)).not.toContain("never made");
  });
});

test.describe("CC's synthesized single default (unconfigured config)", () => {
  // Real claude-commander never returns an empty programs list: with nothing
  // configured it hands back one entry whose label and command both equal
  // default_program. The picker treats that as "unconfigured" and offers the
  // built-in three.
  test.use({
    seed: {
      snapshot: makeSnapshot(),
      reviews: {},
      defaultProgram: "claude",
      programs: [{ label: "claude", command: "claude" }],
    },
  });

  test("the built-in three are shown, not the lone synthesized entry", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    expect(await sidebar.harnessMenuItems()).toEqual([
      "Claude · claude",
      "Codex · codex",
      "OpenCode · opencode",
    ]);
  });
});

test.describe("synthesized default for a non-claude default_program", () => {
  // e.g. a config migrated from default_program = "codex" — still the synthesized
  // shape (label === command === default_program), so still the built-in three.
  test.use({
    seed: {
      snapshot: makeSnapshot(),
      reviews: {},
      defaultProgram: "codex",
      programs: [{ label: "codex", command: "codex" }],
    },
  });

  test("offers the built-in three (first entry Claude)", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    expect(await sidebar.harnessMenuItems()).toEqual([
      "Claude · claude",
      "Codex · codex",
      "OpenCode · opencode",
    ]);
    await expect(sidebar.harnessCommand()).toHaveText("claude");
  });
});

test.describe("a genuine single-entry configured list is respected", () => {
  // One entry, but with a distinct display label — a real user configuration, so
  // shown as-is rather than replaced by the built-in set.
  test.use({
    seed: {
      snapshot: makeSnapshot(),
      reviews: {},
      defaultProgram: "claude --model opus",
      programs: [{ label: "Claude (Opus)", command: "claude --model opus" }],
    },
  });

  test("shows only the configured entry", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    expect(await sidebar.harnessMenuItems()).toEqual(["Claude (Opus) · claude --model opus"]);
  });
});

test.describe("configured programs list (non-empty)", () => {
  // The user's own order — Codex first — so the picker's first entry is codex.
  test.use({
    seed: {
      snapshot: makeSnapshot(),
      reviews: {},
      programs: [
        { label: "Codex", command: "codex" },
        { label: "Claude", command: "claude --model opus" },
      ],
    },
  });

  test("the configured list is shown in the user's order", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await sidebar.openHarnessMenu();
    expect(await sidebar.harnessMenuItems()).toEqual([
      "Codex · codex",
      "Claude · claude --model opus",
    ]);
  });

  test("caret defaults to the first configured entry", async ({ sidebar }) => {
    await sidebar.openInlineCreate("acme");
    await expect(sidebar.harnessCommand()).toHaveText("codex");
  });

  test("a configured command (with flags) threads through verbatim", async ({ sidebar }) => {
    await sidebar.createWithHarness("acme", "opus session", "claude --model opus");
    await expect(async () => {
      expect(await sidebar.programOf("opus session")).toBe("claude --model opus");
    }).toPass();
  });
});

test.describe("per-project last-used memory", () => {
  test.use({
    seed: {
      snapshot: makeSnapshot({
        groups: [
          {
            id: "proj-1",
            name: "acme",
            repo_path: "/repos/acme",
            pull_blocked: null,
            sessions: [makeSession({ id: "sess-1", title: "acme work" })],
          },
          {
            id: "proj-2",
            name: "beta",
            repo_path: "/repos/beta",
            pull_blocked: null,
            sessions: [makeSession({ id: "sess-2", title: "beta work", project_id: "proj-2" })],
          },
        ],
      }),
      reviews: {},
    },
  });

  test("reopening a project pre-selects the harness last used there", async ({ sidebar }) => {
    await sidebar.createWithHarness("acme", "first acme session", "opencode");
    await expect(async () => {
      expect(await sidebar.programOf("first acme session")).toBe("opencode");
    }).toPass();

    await sidebar.openInlineCreate("acme");
    await expect(sidebar.harnessCommand()).toHaveText("opencode");
  });

  test("the memory does not leak into an unrelated project", async ({ sidebar }) => {
    await sidebar.createWithHarness("acme", "acme codex session", "codex");

    await sidebar.openInlineCreate("beta");
    await expect(sidebar.harnessCommand()).toHaveText("claude");
  });
});

test.describe("stale remembered harness", () => {
  // A remembered command no longer offered by the shown list falls back to the
  // first entry, so a stale preference never selects a missing option.
  test.use({
    seed: {
      snapshot: makeSnapshot(),
      reviews: {},
      programs: [
        { label: "Codex", command: "codex" },
        { label: "OpenCode", command: "opencode" },
      ],
    },
  });

  test("falls back to the first entry when the remembered command is gone", async ({ sidebar }) => {
    // "claude" is not in this configured list.
    await sidebar.seedHarnessMemory("/repos/acme", "claude");

    await sidebar.openInlineCreate("acme");
    await expect(sidebar.harnessCommand()).toHaveText("codex");
  });
});

test.describe("create-session dialog entry point (section view)", () => {
  test.use({
    seed: {
      viewMode: "sections",
      snapshot: makeSnapshot({
        section_names: ["Review"],
        sections: [
          { name: "In Progress", session_ids: ["sess-1"] },
          { name: "Review", session_ids: [] },
        ],
        groups: [
          {
            id: "proj-1",
            name: "acme",
            repo_path: "/repos/acme",
            pull_blocked: null,
            sessions: [makeSession({ id: "sess-1", title: "acme work" })],
          },
          {
            id: "proj-2",
            name: "beta",
            repo_path: "/repos/beta",
            pull_blocked: null,
            sessions: [],
          },
        ],
      }),
      reviews: {},
    },
  });

  test("the dialog exposes the same picker and threads the chosen harness", async ({ sidebar }) => {
    await sidebar.openCreateDialog("beta");
    await expect(sidebar.harnessCommand(".confirm-overlay")).toHaveText("claude");

    await sidebar.openHarnessMenu(".confirm-overlay");
    await sidebar.selectHarness("opencode");
    await expect(sidebar.harnessCommand(".confirm-overlay")).toHaveText("opencode");

    await sidebar.submitCreateDialog("beta via dialog");

    await expect(async () => {
      expect(await sidebar.programOf("beta via dialog")).toBe("opencode");
    }).toPass();
  });
});
