import { describe, it, expect } from "vitest";
import { altArrowBytes } from "./altArrow";

const chord = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
  key,
  altKey: mods.altKey ?? false,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  shiftKey: mods.shiftKey ?? false,
});

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

describe("altArrowBytes", () => {
  it("sends readline's ESC b / ESC f for Left/Right on macOS", () => {
    expect(altArrowBytes(chord("ArrowLeft", { altKey: true }), true)).toBe("\x1bb");
    expect(altArrowBytes(chord("ArrowRight", { altKey: true }), true)).toBe("\x1bf");
  });

  it("leaves Up/Down to xterm on macOS", () => {
    expect(altArrowBytes(chord("ArrowUp", { altKey: true }), true)).toBeNull();
    expect(altArrowBytes(chord("ArrowDown", { altKey: true }), true)).toBeNull();
  });

  it("sends the Ctrl+arrow sequences elsewhere", () => {
    expect(altArrowBytes(chord("ArrowLeft", { altKey: true }), false)).toBe("\x1b[1;5D");
    expect(altArrowBytes(chord("ArrowRight", { altKey: true }), false)).toBe("\x1b[1;5C");
    expect(altArrowBytes(chord("ArrowUp", { altKey: true }), false)).toBe("\x1b[1;5A");
    expect(altArrowBytes(chord("ArrowDown", { altKey: true }), false)).toBe("\x1b[1;5B");
  });

  it("ignores Alt combined with another modifier", () => {
    for (const isMac of [true, false]) {
      for (const extra of ["metaKey", "ctrlKey", "shiftKey"] as const) {
        for (const key of ARROWS) {
          expect(altArrowBytes(chord(key, { altKey: true, [extra]: true }), isMac)).toBeNull();
        }
      }
    }
  });

  it("ignores arrows without Alt, and other Alt keys", () => {
    for (const isMac of [true, false]) {
      for (const key of ARROWS) {
        expect(altArrowBytes(chord(key), isMac)).toBeNull();
      }
      expect(altArrowBytes(chord("b", { altKey: true }), isMac)).toBeNull();
    }
  });
});
