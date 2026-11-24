// CON-19: Rich mode for Markdown was deleted; a tab saved in it opens in Live, and other modes are kept.
import { describe, expect, it } from "vitest";
import { knownKinds, type Tab } from "./store";

describe("a saved layout from before Rich mode was deleted", () => {
  it("opens a page or note saved in Rich mode in Live, and leaves other modes alone", () => {
    const stored = { panes: [{ id: "p", tabs: [
      { id: "a", kind: "file", file: { notebook: "nb", path: "A.md" }, mode: "rich" },
      { id: "b", kind: "note", ref: "d:1", mode: "rich" },
      { id: "c", kind: "file", file: { notebook: "nb", path: "C.md" }, mode: "source" },
      { id: "d", kind: "file", file: { notebook: "nb", path: "D.md" } },
    ], active: "a" }] } as never;
    const tabs = knownKinds(stored).panes![0].tabs as Tab[];
    expect(tabs.map((t) => [t.id, t.mode])).toEqual([["a", "live"], ["b", "live"], ["c", "source"], ["d", undefined]]);
  });
});
