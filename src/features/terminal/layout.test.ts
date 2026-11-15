import { describe, expect, it } from "vitest";
import { closeTab, EMPTY, focusPane, moveTab, openIn, reconcile, sane, toggleSplit, type Layout } from "./layout";

const two: Layout = { split: true, panes: [["a", "b"], ["c"]], active: ["a", "c"], focus: 0 };

describe("openIn", () => {
  it("adds a new tab to the focused pane and makes it active", () => {
    expect(openIn(two, "d").panes).toEqual([["a", "b", "d"], ["c"]]);
    expect(openIn({ ...two, focus: 1 }, "d")).toMatchObject({ panes: [["a", "b"], ["c", "d"]], active: ["a", "d"], focus: 1 });
  });
  it("focuses the pane that has the tab", () => {
    expect(openIn(two, "c")).toMatchObject({ focus: 1, active: ["a", "c"] });
    expect(openIn(two, "b")).toMatchObject({ focus: 0, active: ["b", "c"] });
  });
  it("uses the first pane when split is off", () => {
    expect(openIn({ ...EMPTY, focus: 1 }, "a")).toMatchObject({ panes: [["a"], []], focus: 0, active: ["a", null] });
  });
});

describe("moveTab", () => {
  it("moves the tab, activates it there and focuses that pane", () => {
    expect(moveTab(two, "a", 1)).toEqual({ split: true, panes: [["b"], ["c", "a"]], active: ["b", "a"], focus: 1 });
  });
  it("leaves the source pane empty when it was the only tab", () => {
    expect(moveTab(two, "c", 0)).toEqual({ split: true, panes: [["a", "b", "c"], []], active: ["c", null], focus: 0 });
  });
  it("does nothing for the same pane, an unknown tab or no split", () => {
    expect(moveTab(two, "a", 0)).toBe(two);
    expect(moveTab(two, "x", 1)).toBe(two);
    const off: Layout = { ...two, split: false, panes: [["a"], []], active: ["a", null] };
    expect(moveTab(off, "a", 1)).toBe(off);
  });
});

describe("closeTab", () => {
  it("shows the neighbour when the active tab closes", () => {
    expect(closeTab(two, "a")).toMatchObject({ panes: [["b"], ["c"]], active: ["b", "c"] });
    expect(closeTab({ ...two, active: ["b", "c"] }, "b").active).toEqual(["a", "c"]);
  });
  it("keeps the active tab when another closes", () => {
    expect(closeTab(two, "b").active).toEqual(["a", "c"]);
  });
  it("empties a pane", () => {
    expect(closeTab(two, "c")).toMatchObject({ panes: [["a", "b"], []], active: ["a", null] });
  });
});

describe("toggleSplit", () => {
  it("turns the second pane on, empty", () => {
    expect(toggleSplit({ ...EMPTY, panes: [["a"], []], active: ["a", null] })).toMatchObject({ split: true, panes: [["a"], []] });
  });
  it("merges the second pane into the first when turned off", () => {
    expect(toggleSplit(two)).toEqual({ split: false, panes: [["a", "b", "c"], []], active: ["a", null], focus: 0 });
  });
  it("keeps the focused pane's active tab visible", () => {
    expect(toggleSplit({ ...two, focus: 1 }).active).toEqual(["c", null]);
  });
});

describe("focusPane", () => {
  it("focuses the second pane only when split", () => {
    expect(focusPane(two, 1).focus).toBe(1);
    expect(focusPane({ ...two, split: false }, 1).focus).toBe(0);
  });
});

describe("reconcile", () => {
  it("drops tabs that are gone and fixes the active one", () => {
    expect(reconcile(two, ["b", "c"])).toMatchObject({ panes: [["b"], ["c"]], active: ["b", "c"] });
  });
  it("adds new tabs to the focused pane", () => {
    expect(reconcile({ ...two, focus: 1 }, ["a", "b", "c", "d"]).panes).toEqual([["a", "b"], ["c", "d"]]);
    expect(reconcile(EMPTY, ["a", "b"])).toMatchObject({ panes: [["a", "b"], []], active: ["a", null] });
  });
  it("returns the same object when nothing changes", () => {
    expect(reconcile(two, ["a", "b", "c"])).toBe(two);
  });
});

describe("sane", () => {
  it("accepts a valid layout and rejects garbage", () => {
    expect(sane(two)).toEqual(two);
    expect(sane({ split: "yes" })).toBe(EMPTY);
    expect(sane({ ...two, panes: [["a"], ["a"]] })).toBe(EMPTY);
    expect(sane(null)).toBe(EMPTY);
  });
});

describe("shell ids", () => {
  const withShell: Layout = { split: false, panes: [["a", "shell-1"], []], active: ["shell-1", null], focus: 0 };
  it("keeps a running shell next to sessions when both lists are given", () => {
    expect(reconcile(withShell, ["a", "shell-1"])).toBe(withShell);
  });
  it("drops a shell that is no longer listed and adds a new one to the focused pane", () => {
    expect(reconcile(withShell, ["a"])).toMatchObject({ panes: [["a"], []], active: ["a", null] });
    expect(reconcile(withShell, ["a", "shell-1", "shell-2"]).panes[0]).toEqual(["a", "shell-1", "shell-2"]);
  });
  it("moves and closes a shell tab like any other", () => {
    const split: Layout = { ...withShell, split: true };
    expect(moveTab(split, "shell-1", 1)).toMatchObject({ panes: [["a"], ["shell-1"]], active: ["a", "shell-1"] });
    expect(closeTab(split, "shell-1")).toMatchObject({ panes: [["a"], []], active: ["a", null] });
  });
  it("accepts a stored layout with shell ids", () => {
    expect(sane(withShell)).toEqual(withShell);
  });
});
