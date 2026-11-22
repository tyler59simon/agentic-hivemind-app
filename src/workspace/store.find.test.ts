// NS-6B: the find tab is one tab, belongs to the Notes page and is not reopened after a restart; a file tab in the viewer is.
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { knownKinds, useWorkspace } from "./store";

beforeEach(() => {
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} });
  useApp.setState({ route: { page: "home" } as never });
});

describe("the find in files tab", () => {
  it("is a single tab on the Notes page", () => {
    useWorkspace.getState().openTab({ kind: "find" });
    useWorkspace.getState().openTab({ kind: "find" });
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.kind)).toEqual(["find"]);
    expect(useApp.getState().route.page).toBe("notes");
  });

  it("is not kept over a restart, but a file tab left in a viewer is", () => {
    useWorkspace.getState().openTab({ kind: "find" });
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "huge.log" }, mode: "bigfile" });
    const kept = useWorkspace.persist.getOptions().partialize!(useWorkspace.getState()) as { panes: { tabs: { kind: string; mode?: string }[] }[] };
    expect(kept.panes[0].tabs.map((t) => [t.kind, t.mode])).toEqual([["file", "bigfile"]]);
    // A saved layout with a find tab (an older build never wrote one) still loads.
    expect(knownKinds({ panes: [{ id: "p", tabs: [{ id: "t", kind: "find" }], active: "t" }] }).panes![0].tabs).toHaveLength(1);
  });

  it("a second view of a viewer tab is a viewer too", () => {
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "blob.bin" }, mode: "hex" });
    useWorkspace.getState().split();
    const tabs = useWorkspace.getState().panes.flatMap((p) => p.tabs);
    expect(tabs.map((t) => t.mode)).toEqual(["hex", "hex"]);
  });
});
