// @vitest-environment jsdom
// A tab's own choice of white paper: kept with the workspace across a restart, and a workspace saved before it loads.
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { knownKinds, useWorkspace, type Tab } from "./store";

const ws = () => useWorkspace.getState();
const KEY = "hivemind.workspace";
const tabs = () => ws().panes.flatMap((p) => p.tabs);

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, rail: true, railSplit: false, reveal: null });
  useApp.setState({ route: { page: "home" }, back: [] });
});

describe("a tab's paper choice", () => {
  it("follows the setting until it is flipped, and a flip is that tab's alone", () => {
    ws().openNote("d:1");
    ws().openNote("d:2");
    const [a, b] = tabs();
    expect(a.paper).toBeUndefined();
    ws().updateTab(a.id, { paper: true });
    expect(tabs().map((t) => t.paper)).toEqual([true, undefined]);
    ws().updateTab(a.id, { paper: false });
    expect(tabs().find((t) => t.id === b.id)!.paper).toBeUndefined();
    expect(tabs().find((t) => t.id === a.id)!.paper).toBe(false);
  });

  it("goes with the tab into a second view", () => {
    ws().openTab({ kind: "file", file: { notebook: "nb", path: "A.md" }, mode: "live", paper: true });
    ws().split();
    expect(ws().panes.map((p) => p.tabs[0].paper)).toEqual([true, true]);
  });

  it("survives a restart with the rest of the workspace", async () => {
    ws().openNote("d:1");
    ws().openTab({ kind: "file", file: { notebook: "nb", path: "A.md" }, mode: "reading" });
    ws().updateTab(tabs()[0].id, { paper: true });
    ws().updateTab(tabs()[1].id, { paper: false });
    const saved = localStorage.getItem(KEY)!;
    expect(saved).toContain('"paper":true');
    // The next start: the layout in memory is gone, the stored one remains.
    useWorkspace.setState({ panes: [{ id: "x", tabs: [], active: null }], focused: "x" });
    localStorage.setItem(KEY, saved);
    await useWorkspace.persist.rehydrate();
    expect(tabs().map((t) => [t.kind, t.paper])).toEqual([["note", true], ["file", false]]);
  });

  it("is not stored for a tab that never chose", async () => {
    ws().openNote("d:1");
    expect(localStorage.getItem(KEY)).not.toContain("paper");
    await useWorkspace.persist.rehydrate();
    expect(tabs()[0].paper).toBeUndefined();
  });

  it("loads from a workspace saved before the choice existed", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 3,
      state: {
        focused: "p9", rail: true, railSplit: false,
        panes: [{ id: "p9", active: "t2", tabs: [
          { id: "t1", kind: "note", ref: "d:1", mode: "reading", title: "One" },
          { id: "t2", kind: "file", file: { notebook: "nb", path: "A.md" }, mode: "live" },
        ] }],
      },
    }));
    await useWorkspace.persist.rehydrate();
    expect(tabs().map((t) => [t.id, t.paper])).toEqual([["t1", undefined], ["t2", undefined]]);
    expect(ws().focused).toBe("p9");
  });

  it("drops a stored value that is not true or false", () => {
    const stored = { panes: [{ id: "p", active: "t", tabs: [{ id: "t", kind: "note", ref: "d:1", paper: "yes" }] }] } as unknown as Partial<ReturnType<typeof ws>>;
    const kept = knownKinds(stored).panes![0].tabs[0] as Tab;
    expect(kept.paper).toBeUndefined();
    expect(kept.ref).toBe("d:1");
  });
});
