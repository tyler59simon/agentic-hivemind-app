import { beforeEach, describe, expect, it } from "vitest";
import { activeTab, MAX_PANES, useWorkspace } from "./store";

const ws = () => useWorkspace.getState();
const reset = () => {
  const pane = { id: "p0", tabs: [], active: null };
  useWorkspace.setState({ panes: [pane], focused: "p0", dirty: {}, panel: "outline", reveal: null });
};

describe("workspace", () => {
  beforeEach(reset);

  it("opens a note once and re-focuses it", () => {
    ws().openNote("d:1", { title: "One" });
    ws().openNote("d:2");
    ws().openNote("d:1");
    expect(ws().panes[0].tabs.map((t) => t.ref)).toEqual(["d:1", "d:2"]);
    expect(activeTab(ws())?.ref).toBe("d:1");
  });

  it("splits into a new pane up to the limit, then reuses the other pane", () => {
    ws().openNote("d:1");
    ws().openNote("d:1", { split: true });
    expect(ws().panes).toHaveLength(2);
    expect(activeTab(ws())?.ref).toBe("d:1");
    expect(ws().focused).toBe(ws().panes[1].id);
    ws().focus(ws().panes[0].id);
    ws().openNote("d:2", { split: true });
    expect(ws().panes).toHaveLength(2); // the other pane exists, so it is reused
    for (let i = 0; i < 5; i++) ws().split();
    expect(ws().panes.length).toBeLessThanOrEqual(MAX_PANES);
  });

  it("closing the last tab of a pane removes the pane, except the last pane", () => {
    ws().openNote("d:1");
    ws().openNote("d:2", { split: true });
    const second = ws().panes[1];
    ws().closeTab(second.id, second.tabs[0].id);
    expect(ws().panes).toHaveLength(1);
    const first = ws().panes[0];
    ws().closeTab(first.id, first.tabs[0].id);
    expect(ws().panes).toHaveLength(1);
    expect(ws().panes[0].tabs).toEqual([]);
  });

  it("activates a neighbour when the active tab closes, and forgets its dirty flag", () => {
    ws().openNote("d:1"); ws().openNote("d:2"); ws().openNote("d:3");
    const pane = ws().panes[0];
    ws().activate(pane.id, pane.tabs[1].id);
    ws().setDirty(pane.tabs[1].id, true);
    ws().closeTab(pane.id, pane.tabs[1].id);
    expect(activeTab(ws())?.ref).toBe("d:3");
    expect(ws().dirty).toEqual({});
  });

  it("cycles tabs both ways and replaces a new note's ref after capture", () => {
    ws().openNote("d:1"); ws().openNote("d:2");
    ws().cycle(1);
    expect(activeTab(ws())?.ref).toBe("d:1");
    ws().cycle(-1);
    expect(activeTab(ws())?.ref).toBe("d:2");
    ws().replaceRef("d:2", "d:9");
    expect(ws().panes[0].tabs.map((t) => t.ref)).toEqual(["d:1", "d:9"]);
  });

  it("dedupes project tabs by slug and keeps work a singleton", () => {
    ws().openProject("a", "Alpha");
    ws().openProject("b");
    ws().openProject("a");
    ws().openTab({ kind: "work" });
    ws().openTab({ kind: "work" });
    expect(ws().panes[0].tabs.map((t) => [t.kind, t.slug])).toEqual([["project", "a"], ["project", "b"], ["work", undefined]]);
  });
});
