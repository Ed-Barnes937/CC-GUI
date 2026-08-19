import { describe, it, expect, beforeEach } from "vitest";
import {
  registerFeature,
  allFeatures,
  isEnabled,
  setEnabled,
  onFeatureChange,
  featurePalette,
  featureActions,
  resetFeaturesForTest,
  type Feature,
} from "./features";

function feature(over: Partial<Feature> = {}): Feature {
  return {
    id: "demo",
    name: "Demo",
    desc: "A demo feature.",
    defaultEnabled: false,
    ...over,
  };
}

const entry = (label: string) => ({ label, hint: "command", action: () => {} });

beforeEach(() => resetFeaturesForTest());

describe("enablement", () => {
  it("falls back to the feature's default when the user hasn't chosen", () => {
    registerFeature(feature({ id: "off", defaultEnabled: false }));
    registerFeature(feature({ id: "on", defaultEnabled: true }));
    expect(isEnabled("off")).toBe(false);
    expect(isEnabled("on")).toBe(true);
  });

  it("remembers an explicit choice, including one that matches a later default", () => {
    registerFeature(feature({ id: "demo", defaultEnabled: true }));
    setEnabled("demo", false);
    expect(isEnabled("demo")).toBe(false);
    // Re-registering with a flipped default must not resurrect the feature: the
    // user said no.
    registerFeature(feature({ id: "demo", defaultEnabled: true }));
    expect(isEnabled("demo")).toBe(false);
  });

  it("reports an unregistered feature as disabled", () => {
    expect(isEnabled("nope")).toBe(false);
  });

  it("ignores a choice for an unregistered feature", () => {
    setEnabled("nope", true);
    expect(isEnabled("nope")).toBe(false);
  });

  it("survives a corrupt store by using every default", () => {
    localStorage.setItem("cc-features", "{not json");
    registerFeature(feature({ id: "demo", defaultEnabled: true }));
    expect(isEnabled("demo")).toBe(true);
  });

  it("ignores non-boolean stored values", () => {
    localStorage.setItem("cc-features", JSON.stringify({ demo: "yes" }));
    registerFeature(feature({ id: "demo", defaultEnabled: true }));
    expect(isEnabled("demo")).toBe(true);
  });
});

describe("registration", () => {
  it("keeps registration order and replaces a re-registered id", () => {
    registerFeature(feature({ id: "a", name: "A" }));
    registerFeature(feature({ id: "b", name: "B" }));
    registerFeature(feature({ id: "a", name: "A2" }));
    expect(allFeatures().map((f) => [f.id, f.name])).toEqual([
      ["a", "A2"],
      ["b", "B"],
    ]);
  });
});

describe("contributions", () => {
  it("collects palette entries from enabled features only", () => {
    registerFeature(feature({ id: "a", defaultEnabled: true, palette: () => [entry("A")] }));
    registerFeature(feature({ id: "b", defaultEnabled: false, palette: () => [entry("B")] }));
    expect(featurePalette().map((e) => e.label)).toEqual(["A"]);
    setEnabled("b", true);
    expect(featurePalette().map((e) => e.label)).toEqual(["A", "B"]);
    setEnabled("a", false);
    expect(featurePalette().map((e) => e.label)).toEqual(["B"]);
  });

  it("re-reads the palette provider on every call", () => {
    let n = 0;
    registerFeature(feature({ defaultEnabled: true, palette: () => [entry(`call ${++n}`)] }));
    expect(featurePalette()[0].label).toBe("call 1");
    expect(featurePalette()[0].label).toBe("call 2");
  });

  it("omits a disabled feature's keybinding actions entirely", () => {
    const run = () => {};
    registerFeature(feature({ defaultEnabled: false, actions: { demo_open: { label: "Open demo", run } } }));
    expect(featureActions()).toEqual({});
    setEnabled("demo", true);
    expect(featureActions()).toEqual({ demo_open: { label: "Open demo", run } });
  });
});

describe("change notifications", () => {
  it("fires on a real change and stays silent on a no-op", () => {
    registerFeature(feature({ defaultEnabled: false }));
    let fired = 0;
    onFeatureChange(() => fired++);
    setEnabled("demo", false); // already off
    expect(fired).toBe(0);
    setEnabled("demo", true);
    expect(fired).toBe(1);
    setEnabled("demo", true); // already on
    expect(fired).toBe(1);
  });
});
