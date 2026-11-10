import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { activeTab, MAX_PANES, notesOnly, useWorkspace } from "./store";

const ws = () => useWorkspace.getState();
const reset = () => {
  const pane = { id: "p0", tabs: [], active: null };
  useWorkspace.setState({ panes: [pane], focused: "p0", dirty: {}, rail: true, reveal: null });
  useApp.setState({ route: { page: "overview" }, back: [] });
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

  it("opening a note or a new note shows the Memory page's notes", () => {
    ws().openNote("d:1");
    expect(useApp.getState().route).toEqual({ page: "memory", view: "notes" });
    useApp.getState().go({ page: "overview" });
    ws().openNote("d:1"); // already open: still brought into view
    expect(useApp.getState().route).toEqual({ page: "memory", view: "notes" });
  });

  it("a new note is always its own tab", () => {
    ws().openTab({ kind: "new-note" });
    ws().openTab({ kind: "new-note" });
    expect(ws().panes[0].tabs.map((t) => t.kind)).toEqual(["new-note", "new-note"]);
  });

  it("an older stored layout keeps only its note tabs", () => {
    const stored = {
      focused: "b", panel: null,
      panes: [
        { id: "a", active: "t2", tabs: [{ id: "t1", kind: "note", ref: "d:1" }, { id: "t2", kind: "graph" }] },
        { id: "b", active: "t3", tabs: [{ id: "t3", kind: "project", slug: "x" }] },
      ],
    } as unknown as Parameters<typeof notesOnly>[0];
    const next = notesOnly(stored);
    expect(next.panes.map((p) => [p.id, p.active, p.tabs.map((t) => t.id)])).toEqual([["a", "t1", ["t1"]]]);
    expect([next.focused, next.rail]).toEqual(["a", false]);
    expect(notesOnly({}).panes).toHaveLength(1);
  });
});
