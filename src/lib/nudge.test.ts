import { describe, expect, it } from "vitest";
import { joinsRun, KEY_STEP, MERGE_MS, nudgeOf, splitKeyShare, type Run } from "./nudge";

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

describe("joinsRun", () => {
  it("joins a press of the same kind within a second, and starts a new step for another kind, a pause or a plain commit", () => {
    const run: { current: Run } = { current: null };
    expect(joinsRun(run, "key-move", 0)).toBe(false);
    expect(joinsRun(run, "key-move", 400)).toBe(true);
    expect(joinsRun(run, "key-resize", 500)).toBe(false);
    expect(joinsRun(run, "key-resize", 500 + MERGE_MS)).toBe(false);
    expect(joinsRun(run, "key-resize", 600 + MERGE_MS)).toBe(true);
    expect(joinsRun(run, undefined, 700 + MERGE_MS)).toBe(false);
    expect(joinsRun(run, "key-resize", 800 + MERGE_MS)).toBe(false);
  });
});

describe("splitKeyShare", () => {
  it("moves the divider 5 points with the arrows, to the limits with Home and End, and stays inside them", () => {
    expect(splitKeyShare("ArrowRight", 0.45)).toBe(0.5);
    expect(splitKeyShare("ArrowLeft", 0.45)).toBe(0.4);
    expect(splitKeyShare("ArrowLeft", 0.2)).toBe(0.2);
    expect(splitKeyShare("ArrowRight", 0.8)).toBe(0.8);
    expect(splitKeyShare("Home", 0.5)).toBe(0.2);
    expect(splitKeyShare("End", 0.5)).toBe(0.8);
    expect(splitKeyShare("a", 0.5)).toBeNull();
  });
});
