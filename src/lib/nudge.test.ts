import { describe, expect, it } from "vitest";
import { KEY_STEP, nudgeOf } from "./nudge";

const press = (key: string, mods: Partial<Parameters<typeof nudgeOf>[0]> = {}) => nudgeOf({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("nudgeOf", () => {
  it("moves with Ctrl or Cmd and an arrow, by one step in that direction", () => {
    expect(press("ArrowRight", { ctrlKey: true })).toEqual({ kind: "move", dx: KEY_STEP, dy: 0 });
    expect(press("ArrowUp", { metaKey: true })).toEqual({ kind: "move", dx: 0, dy: -KEY_STEP });
  });
  it("resizes with Shift as well", () => {
    expect(press("ArrowDown", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "resize", dx: 0, dy: KEY_STEP });
    expect(press("ArrowLeft", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "resize", dx: -KEY_STEP, dy: 0 });
  });
  it("leaves a bare arrow, Shift+arrow and Alt+arrow (Alt+Left is Back) and other keys alone", () => {
    expect(press("ArrowLeft")).toBeNull();
    expect(press("ArrowLeft", { shiftKey: true })).toBeNull();
    expect(press("ArrowLeft", { altKey: true })).toBeNull();
    expect(press("ArrowLeft", { ctrlKey: true, altKey: true })).toBeNull();
    expect(press("a", { ctrlKey: true })).toBeNull();
  });
});
