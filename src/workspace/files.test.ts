import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { activeTab, useWorkspace, type Pane } from "./store";

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

  it("loads version 2 data unchanged and sends version 1 through notesOnly", () => {
    const v2 = { panes: [{ id: "p", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t" }], focused: "p" };
    expect(options().migrate!(v2, 2)).toEqual(v2);
    const v1 = { panes: [{ id: "p", tabs: [{ id: "t", kind: "graph" }, { id: "u", kind: "note", ref: "d:1" }], active: "t" }], focused: "p" };
    const migrated = options().migrate!(v1, 1) as { panes: Pane[] };
    expect(migrated.panes[0].tabs.map((t) => t.kind)).toEqual(["note"]);
  });

  // CON-18: a tab of a hosted notebook (container lm:<domain>:<notebook>) has no notebook to read from any more.
  it("is version 4, and drops the tabs of hosted notebooks, keeping the rest and a sensible active tab", () => {
    expect(options().version).toBe(4);
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

  it("drops tabs of unknown kinds and file tabs without a file", () => {
    const stored = {
      panes: [{ id: "p", tabs: [{ id: "a", kind: "canvas" }, { id: "b", kind: "file" }, { id: "c", kind: "file", file: { notebook: "nb", path: "x.md" } }], active: "a" }],
      focused: "p",
    };
    const merged = options().merge!(stored, ws()) as { panes: Pane[] };
    expect(merged.panes[0].tabs.map((t) => t.id)).toEqual(["c"]);
  });
});
