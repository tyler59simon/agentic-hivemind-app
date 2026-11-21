import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { activeTab, useWorkspace, type Pane } from "./store";

const ws = () => useWorkspace.getState();
const reset = () => {
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, rail: true, railSplit: false, reveal: null });
  useApp.setState({ route: { page: "overview" }, back: [] });
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

  it("goes to Notes for a page and Memory for a note, but stays where the workspace already shows", () => {
    ws().openTab(page("A.md"));
    expect(useApp.getState().route).toEqual({ page: "notes" });
    ws().openNote("d:1");
    expect(useApp.getState().route).toEqual({ page: "notes" });
    useApp.setState({ route: { page: "overview" } });
    ws().openNote("d:2");
    expect(useApp.getState().route).toEqual({ page: "memory", view: "notes" });
    ws().openTab(page("B.md"));
    expect(useApp.getState().route).toEqual({ page: "memory", view: "notes" });
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

  it("drops tabs of unknown kinds and file tabs without a file", () => {
    const stored = {
      panes: [{ id: "p", tabs: [{ id: "a", kind: "canvas" }, { id: "b", kind: "file" }, { id: "c", kind: "file", file: { notebook: "nb", path: "x.md" } }], active: "a" }],
      focused: "p",
    };
    const merged = options().merge!(stored, ws()) as { panes: Pane[] };
    expect(merged.panes[0].tabs.map((t) => t.id)).toEqual(["c"]);
  });
});
