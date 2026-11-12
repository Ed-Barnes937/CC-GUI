import { describe, it, expect } from "vitest";
import { wordJumpBytes } from "./wordJump";

const chord = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
  key,
  altKey: mods.altKey ?? false,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  shiftKey: mods.shiftKey ?? false,
});

describe("wordJumpBytes", () => {
  it("sends readline's ESC b / ESC f on macOS", () => {
    expect(wordJumpBytes(chord("ArrowLeft", { altKey: true }), true)).toBe("\x1bb");
    expect(wordJumpBytes(chord("ArrowRight", { altKey: true }), true)).toBe("\x1bf");
  });

  it("sends Ctrl+Left / Ctrl+Right elsewhere", () => {
    expect(wordJumpBytes(chord("ArrowLeft", { altKey: true }), false)).toBe("\x1b[1;5D");
    expect(wordJumpBytes(chord("ArrowRight", { altKey: true }), false)).toBe("\x1b[1;5C");
  });

  it("ignores Alt combined with another modifier", () => {
    for (const isMac of [true, false]) {
      for (const extra of ["metaKey", "ctrlKey", "shiftKey"] as const) {
        expect(wordJumpBytes(chord("ArrowLeft", { altKey: true, [extra]: true }), isMac)).toBeNull();
        expect(wordJumpBytes(chord("ArrowRight", { altKey: true, [extra]: true }), isMac)).toBeNull();
      }
    }
  });

  it("ignores arrows without Alt, and other Alt keys", () => {
    for (const isMac of [true, false]) {
      expect(wordJumpBytes(chord("ArrowLeft"), isMac)).toBeNull();
      expect(wordJumpBytes(chord("ArrowRight"), isMac)).toBeNull();
      expect(wordJumpBytes(chord("ArrowUp", { altKey: true }), isMac)).toBeNull();
      expect(wordJumpBytes(chord("ArrowDown", { altKey: true }), isMac)).toBeNull();
      expect(wordJumpBytes(chord("b", { altKey: true }), isMac)).toBeNull();
    }
  });
});
