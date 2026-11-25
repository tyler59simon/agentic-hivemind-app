// @vitest-environment jsdom
// The workspace as it is kept and read back (DESK-LAYOUT, review T3): layouts saved by versions 1 to 4 load through the store's own
// rehydrate with equal pane weights and everything else as it was, and a version 5 layout with unequal panes survives a round trip.
import { beforeEach, describe, expect, it } from "vitest";
import { paneSize, useWorkspace } from "./store";

const KEY = "hivemind.workspace";
const note = (id: string, ref = "d:1") => ({ id, kind: "note", ref, mode: "reading" });
const load = async (state: unknown, version: number) => {
  localStorage.setItem(KEY, JSON.stringify({ state, version }));
  await useWorkspace.persist.rehydrate();
  return useWorkspace.getState();
};
const view = () => {
  const s = useWorkspace.getState();
  return { weights: s.panes.map(paneSize), active: s.panes.map((p) => p.active), focused: s.focused, rail: s.rail, railSplit: s.railSplit };
};

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ panes: [{ id: "x", tabs: [], active: null, size: 1 }], focused: "x", rail: true, railSplit: false, railNarrow: false, dirty: {} });
});

describe("a layout saved by an older version", () => {
  it("version 1 keeps its notes, loses the pages that became routes, and its panes weigh the same", async () => {
    await load({ panes: [{ id: "a", tabs: [{ id: "g", kind: "graph" }, note("n1")], active: "g" }, { id: "b", tabs: [note("n2", "d:2")], active: "n2" }], focused: "b", panel: null }, 1);
    expect(view()).toEqual({ weights: [1, 1], active: ["n1", "n2"], focused: "b", rail: false, railSplit: false });
    expect(useWorkspace.getState().panes.map((p) => p.tabs.map((t) => t.id))).toEqual([["n1"], ["n2"]]);
  });

  for (const version of [2, 3]) {
    it(`version ${version} loads as it is, with equal weights`, async () => {
      await load({ panes: [{ id: "a", tabs: [note("n1"), note("n2", "d:2")], active: "n2" }, { id: "b", tabs: [note("n3", "d:3")], active: "n3" }, { id: "c", tabs: [], active: null }], focused: "a", rail: false, railSplit: true }, version);
      expect(view()).toEqual({ weights: [1, 1, 1], active: ["n2", "n3", null], focused: "a", rail: false, railSplit: true });
    });
  }

  it("version 4 drops hosted tabs, keeps the rest, and gives the panes equal weights", async () => {
    const hosted = { id: "h", kind: "file", file: { notebook: "lm:demo:plans", path: "A.md" } };
    await load({ panes: [{ id: "a", tabs: [hosted, note("n1")], active: "h" }, { id: "b", tabs: [note("n2", "d:2")], active: "n2" }], focused: "b", rail: true, railSplit: true }, 4);
    expect(view()).toEqual({ weights: [1, 1], active: ["n1", "n2"], focused: "b", rail: true, railSplit: true });
  });
});

describe("a version 5 layout", () => {
  const saved = { panes: [{ id: "a", tabs: [note("n1"), note("n2", "d:2")], active: "n2", size: 0.4 }, { id: "b", tabs: [note("n3", "d:3")], active: "n3", size: 1.6 }], focused: "b", rail: false, railSplit: true };

  it("keeps unequal weights, the active tabs, the focused pane and both rail states", async () => {
    await load(saved, 5);
    expect(view()).toEqual({ weights: [0.4, 1.6], active: ["n2", "n3"], focused: "b", rail: false, railSplit: true });
  });

  it("round trips: what is written is read back", async () => {
    useWorkspace.setState({ panes: saved.panes.map((p) => ({ ...p })) as never, focused: "b", rail: false, railSplit: true });
    const raw = localStorage.getItem(KEY)!;
    const written = JSON.parse(raw);
    expect(written.version).toBe(5);
    expect(written.state.panes.map((p: { size: number }) => p.size)).toEqual([0.4, 1.6]);
    useWorkspace.setState({ panes: [{ id: "x", tabs: [], active: null, size: 1 }], focused: "x", rail: true, railSplit: false });
    localStorage.setItem(KEY, raw); // setState wrote the other layout over it
    await useWorkspace.persist.rehydrate();
    expect(view()).toEqual({ weights: [0.4, 1.6], active: ["n2", "n3"], focused: "b", rail: false, railSplit: true });
  });

  it("scales the weights so they average 1 and holds a bad one: null, a huge one, zero, a string", async () => {
    await load({ ...saved, panes: [{ ...saved.panes[0], size: 1e308 }, { ...saved.panes[1], size: null }, { id: "c", tabs: [], active: null, size: 0 }, { id: "d", tabs: [], active: null, size: "wide" }] }, 5);
    const w = useWorkspace.getState().panes.map((p) => p.size!);
    expect(w.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 9);
    // 20 : 1 : 0.05 : 1 before scaling: the huge one cannot swallow the others.
    expect(w[0] / w[1]).toBeCloseTo(20, 5);
    expect(w[2] / w[1]).toBeCloseTo(0.05, 5);
    expect(w[3]).toBeCloseTo(w[1], 9);
  });
});
