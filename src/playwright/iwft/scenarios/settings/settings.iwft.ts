import { test, expect } from "../../support/fixture.testHelper";
import { makeSnapshot } from "../../network/seed.testHelper";

// A realistic partial claude-commander Config covering the field kinds the pane
// renders, plus keys the pane intentionally does NOT render (keybindings, theme)
// to prove they survive a save untouched.
test.use({
  seed: {
    snapshot: makeSnapshot(),
    reviews: {},
    config: {
      default_program: "claude",
      resume_session: true,
      editor: null,
      conversation: { enabled: true, speed: 1.0, model: "kokoro" },
      telemetry: { enabled: true, endpoint: null, token: null },
      sections: [{ name: "Review", has_label: "ready-for-review" }],
      keybindings: { quit: ["q"] },
      theme: { accent: "#89b4fa" },
    },
  },
});

test("renders typed controls keyed by kind", async ({ settings }) => {
  await settings.open();
  // General is the default category.
  // `default_program` is a legacy nullable fallback since CC v0.25 (programs list).
  expect(await settings.fieldKind("default_program")).toBe("nullable");
  expect(await settings.fieldKind("editor")).toBe("nullable");
  expect(await settings.fieldKind("editor_gui")).toBe("select");
  expect(await settings.fieldTag("editor_gui")).toBe("select");
  // A boolean in another category renders as a toggle.
  await settings.selectCategory("sessions");
  expect(await settings.fieldKind("resume_session")).toBe("toggle");
});

test("a boolean renders as a toggle and persists", async ({ settings }) => {
  await settings.open();
  await settings.selectCategory("sessions");
  await settings.toggle("resume_session", false);
  await settings.save();

  const saved = await settings.savedConfig();
  expect(saved?.resume_session).toBe(false);
});

test("enabling hibernation gates its interval fields and persists", async ({
  settings,
}) => {
  await settings.open();
  await settings.selectCategory("hibernation");
  expect(await settings.fieldKind("hibernate_enabled")).toBe("toggle");
  // Interval fields are disabled until hibernation is enabled.
  expect(await settings.field("hibernate_check_interval_secs").isDisabled()).toBe(true);

  await settings.toggle("hibernate_enabled", true);
  expect(await settings.field("hibernate_check_interval_secs").isDisabled()).toBe(false);
  await settings.setText("hibernate_idle_timeout_secs", "3600");
  await settings.setText("hibernate_check_interval_secs", "120");
  await settings.save();

  const saved = await settings.savedConfig();
  expect(saved?.hibernate_enabled).toBe(true);
  expect(saved?.hibernate_idle_timeout_secs).toBe(3600);
  expect(saved?.hibernate_check_interval_secs).toBe(120);
});

test("a nested field round-trips into its sub-object", async ({ settings }) => {
  await settings.open();
  await settings.selectCategory("conversation");
  await settings.setText("conversation.speed", "1.5");
  await settings.save();

  const saved = await settings.savedConfig();
  expect((saved?.conversation as { speed: number }).speed).toBe(1.5);
  // Sibling field is preserved, not reset to default.
  expect((saved?.conversation as { model: string }).model).toBe("kokoro");
});

test("editing a section persists a proper SectionConfig", async ({ settings }) => {
  await settings.open();
  await settings.selectCategory("sections");
  await settings.setSectionField(0, "name", "Needs Review");
  await settings.save();

  const saved = await settings.savedConfig();
  const sections = saved?.sections as { name: string; has_label: string }[];
  expect(sections[0].name).toBe("Needs Review");
  // A single label round-trips as a scalar (matches the untagged enum).
  expect(sections[0].has_label).toBe("ready-for-review");
});

test("adding a section appends a new SectionConfig", async ({ settings }) => {
  await settings.open();
  await settings.selectCategory("sections");
  await settings.addSection();
  await settings.setSectionField(1, "name", "Blocked");
  await settings.save();

  const saved = await settings.savedConfig();
  const sections = saved?.sections as { name: string }[];
  expect(sections).toHaveLength(2);
  expect(sections[1].name).toBe("Blocked");
});

test("unrendered keys (keybindings, theme) survive the save untouched", async ({
  settings,
}) => {
  await settings.open();
  await settings.selectCategory("general");
  await settings.setText("default_program", "claude --model opus");
  await settings.save();

  const saved = await settings.savedConfig();
  expect(saved?.default_program).toBe("claude --model opus");
  expect(saved?.keybindings).toEqual({ quit: ["q"] });
  expect(saved?.theme).toEqual({ accent: "#89b4fa" });
});

test("the Appearance category switches theme mode (localStorage, not save_config)", async ({
  settings,
}) => {
  await settings.open();
  await settings.selectCategory("theme");
  await settings.setThemeMode("dark");
  expect(await settings.themeMode()).toBe("dark");
  // Theme prefs never go through save_config.
  expect(await settings.savedConfig()).toBeNull();
});

test("the Features category lists optional features, or says there are none", async ({
  settings,
}) => {
  await settings.open();
  await settings.selectCategory("features");

  await expect(settings.panelHeading()).toHaveText("Features");
  // No optional feature is registered yet, so the panel is its empty state.
  // When the first one lands this becomes a switch assertion.
  expect(await settings.panelNotes()).toContain(
    "No optional features are available in this build.",
  );
  // Feature switches are GUI-local, like theme prefs.
  expect(await settings.savedConfig()).toBeNull();
});

test("search filters the nav to matching categories", async ({ settings }) => {
  await settings.open();
  await settings.search("hibern");

  await expect(settings.panelHeading()).toHaveText("Hibernation");
  expect(await settings.navLabels()).toEqual(["Hibernation"]);
  // The filtered-to category is live — its fields render and are editable.
  expect(await settings.fieldKind("hibernate_enabled")).toBe("toggle");
});

test("search matches field labels, not just category names", async ({ settings }) => {
  await settings.open();
  // "Branch prefix" lives in General; "prefix" appears in no category label.
  await settings.search("branch prefix");

  expect(await settings.navLabels()).toContain("General");
  await expect(settings.panelHeading()).toHaveText("General");
});

test("a search with no matches empties both nav and panel", async ({ settings }) => {
  await settings.open();
  await settings.search("zzz-no-such-setting");

  expect(await settings.navLabels()).toEqual([]);
  await expect(settings.panelHeading()).toHaveCount(0);
});

test("clearing the search restores every category", async ({ settings }) => {
  await settings.open();
  await settings.search("hibern");
  await settings.search("");

  const labels = await settings.navLabels();
  expect(labels.length).toBeGreaterThan(10);
  expect(labels).toContain("Appearance");
  // The single nav starts with General and holds the GUI-only Appearance
  // right after it — no tabs.
  expect(labels[0]).toBe("General");
  expect(labels[1]).toBe("Appearance");
  expect(labels[2]).toBe("Features");
});
