import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { activeTab, paneSize, useWorkspace, type Pane } from "./store";

const ws = () => useWorkspace.getState();
const reset = () => {
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, rail: true, railSplit: false, reveal: null });
  useApp.setState({ route: { page: "home" }, back: [] });
};
const page = (path: string, notebook = "nb-1") => ({ kind: "file" as const, file: { notebook, path } });
const options = () => useWorkspace.persist.getOptions();

describe("workspace with notebook pages", () => {
  beforeEach(reset);

  it("opens a page once and re-focuses it; another letter case is another file (Codex re-review of fa08348, W1)", () => {
    ws().openTab(page("Plan.md"));
    ws().openNote("d:1");
    ws().openTab(page("Plan.md"));
    expect(ws().panes[0].tabs).toHaveLength(2);
    expect(activeTab(ws())?.file?.path).toBe("Plan.md");
    ws().openTab(page("plan.md"));
    expect(ws().panes[0].tabs).toHaveLength(3);
  });

  it("never mistakes a page for a note", () => {
    ws().openNote("nb-1:Plan.md");
    ws().openTab(page("Plan.md"));
    expect(ws().panes[0].tabs.map((t) => t.kind)).toEqual(["note", "file"]);
  });

  it("goes to Notes for both pages and memory notes", () => {
    ws().openTab(page("A.md"));
    expect(useApp.getState().route).toEqual({ page: "notes" });
    ws().openNote("d:1");
    expect(useApp.getState().route).toEqual({ page: "notes" });
    useApp.setState({ route: { page: "home" } });
    ws().openNote("d:2");
    expect(useApp.getState().route).toEqual({ page: "notes" });
    ws().openTab(page("B.md"));
    expect(useApp.getState().route).toEqual({ page: "notes" });
  });

  it("splits a page into reading mode, and a text file into source", () => {
    ws().openTab(page("A.md"));
    ws().split();
    expect(activeTab(ws())).toMatchObject({ kind: "file", mode: "reading" });
    reset();
    ws().openTab(page("run.log"));
    ws().split();
    expect(activeTab(ws())).toMatchObject({ kind: "file", mode: "source" });
  });

  it("moves tabs with a renamed page or folder, and leaves others alone", () => {
    ws().openTab(page("Projects/A.md"));
    ws().openTab(page("Projects/Sub/B.md"));
    ws().openTab(page("ProjectsOld/C.md"));
    ws().openTab(page("Projects/A.md", "nb-2"));
    ws().retargetFile("nb-1", "Projects", "Archive/Projects");
    expect(ws().panes[0].tabs.map((t) => `${t.file?.notebook}:${t.file?.path}`)).toEqual([
      "nb-1:Archive/Projects/A.md", "nb-1:Archive/Projects/Sub/B.md", "nb-1:ProjectsOld/C.md", "nb-2:Projects/A.md",
    ]);
  });

  it("loads version 2 data as it is (with a pane size of 1) and sends version 1 through notesOnly", () => {
    const v2 = { panes: [{ id: "p", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t" }], focused: "p" };
    expect(options().migrate!(v2, 2)).toEqual({ ...v2, panes: [{ ...v2.panes[0], size: 1 }] });
    const v1 = { panes: [{ id: "p", tabs: [{ id: "t", kind: "graph" }, { id: "u", kind: "note", ref: "d:1" }], active: "t" }], focused: "p" };
    const migrated = options().migrate!(v1, 1) as { panes: Pane[] };
    expect(migrated.panes[0].tabs.map((t) => t.kind)).toEqual(["note"]);
  });

  // CON-18: a tab of a hosted notebook (container lm:<domain>:<notebook>) has no notebook to read from any more.
  it("drops the tabs of hosted notebooks (version 4), keeping the rest and a sensible active tab", () => {
    expect(options().version).toBe(5);
    const file = (id: string, notebook: string, path = "A.md") => ({ id, kind: "file" as const, file: { notebook, path } });
    const stored = {
      panes: [
        { id: "p1", tabs: [file("a", "lm:demo:plans"), file("b", "nb-1"), { id: "n", kind: "note", ref: "d:1" }], active: "a" },
        { id: "p2", tabs: [file("c", "lm:demo:plans", "B.md")], active: "c" },
        { id: "p3", tabs: [file("d", "nb-1", "C.md"), file("e", "lm:jot:daily")], active: "d" },
      ],
      focused: "p2",
    };
    for (const version of [3, 2]) {
      const migrated = options().migrate!(JSON.parse(JSON.stringify(stored)), version) as { panes: Pane[]; focused: string };
      expect(migrated.panes.map((p) => p.tabs.map((t) => t.id))).toEqual([["b", "n"], [], ["d"]]);
      expect(migrated.panes.map((p) => p.active)).toEqual(["b", null, "d"]);
      expect(migrated.focused).toBe("p2");
    }
    // The merge that loads it keeps every pane, so the workspace never holds a tab of a notebook that is gone.
    const merged = options().merge!(options().migrate!(stored, 3), ws()) as { panes: Pane[] };
    expect(merged.panes.flatMap((p) => p.tabs.map((t) => t.file?.notebook ?? t.ref))).toEqual(["nb-1", "d:1", "nb-1"]);
  });

  // DESK-LAYOUT: version 5 gives every pane a size, whatever version the layout was saved in.
  it("gives every pane a size of 1 when it migrates from versions 1 to 4", () => {
    const v4 = { panes: [{ id: "a", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t" }, { id: "b", tabs: [], active: null }], focused: "a" };
    for (const version of [4, 3, 2]) {
      const migrated = options().migrate!(JSON.parse(JSON.stringify(v4)), version) as { panes: Pane[] };
      expect(migrated.panes.map((p) => p.size)).toEqual([1, 1]);
    }
    const v1 = { panes: [{ id: "p", tabs: [{ id: "u", kind: "note", ref: "d:1" }], active: "u" }], focused: "p" };
    expect((options().migrate!(v1, 1) as { panes: Pane[] }).panes.map((p) => p.size)).toEqual([1]);
    // A saved size survives the load, and a pane without one reads as 1.
    expect(paneSize({ id: "x", tabs: [], active: null })).toBe(1);
    expect(paneSize({ id: "x", tabs: [], active: null, size: -2 })).toBe(1);
    expect(paneSize({ id: "x", tabs: [], active: null, size: 0.4 })).toBe(0.4);
  });

  it("moves width between two panes without changing what they have together, and keeps both open", () => {
    ws().openTab({ kind: "new-note" });
    ws().split();
    const [a, b] = ws().panes.map((p) => p.id);
    expect(ws().panes.map(paneSize)).toEqual([1, 1]);
    ws().resizePanes(a, b, 0.7);
    expect(ws().panes.map(paneSize)).toEqual([1.4, 0.6].map((n) => expect.closeTo(n, 5)));
    ws().resizePanes(a, b, 0); // never to nothing
    expect(paneSize(ws().panes[0])).toBeCloseTo(0.1, 5);
    ws().resizePanes(a, b, Number.NaN); // ignored
    expect(paneSize(ws().panes[0])).toBeCloseTo(0.1, 5);
    ws().resizePanes(a, b, 0.5);
    expect(ws().panes.map(paneSize)).toEqual([1, 1].map((n) => expect.closeTo(n, 5)));
    ws().resizePanes(a, "gone", 0.9); // an unknown pane changes nothing
    expect(ws().panes.map(paneSize)).toEqual([1, 1].map((n) => expect.closeTo(n, 5)));
  });

  it("drops tabs of unknown kinds and file tabs without a file", () => {
    const stored = {
      panes: [{ id: "p", tabs: [{ id: "a", kind: "canvas" }, { id: "b", kind: "file" }, { id: "c", kind: "file", file: { notebook: "nb", path: "x.md" } }], active: "a" }],
      focused: "p",
    };
    const merged = options().merge!(stored, ws()) as { panes: Pane[] };
    expect(merged.panes[0].tabs.map((t) => t.id)).toEqual(["c"]);
  });
});
