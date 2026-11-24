// @vitest-environment jsdom
// Documents on white paper: the pane body of every kind of document tab carries the marker App.css turns white, the tab
// bar and empty panes never do, and the page menu flips one tab. File tabs are the real ones, in every mode.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
Element.prototype.scrollIntoView = () => {};

const files = new Map<string, string>([["A.md", "# A\n\ntext\n"], ["B.txt", "plain\n"], ["P.hmdoc", "{}"]]);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: "page" })), truncated: false };
      case "file_read":
        return { text: files.get(path) ?? "", sha256: "sha", size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "asset_base": return "http://hmfile.localhost/g1/";
    }
    return null;
  }),
}));
// A memory note and a new note need Living Memory; their tab content is not what is under test.
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => <div className="note-page" /> }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => <article className="note editing" /> }));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");
const { useApp } = await import("../store");
const { applyPaperDefault, onDocumentLook } = await import("../lib/paper");
const docs = await import("../documents/store");
const { startDocumentSync } = await import("../documents/sync");

const ws = () => useWorkspace.getState();
const file = (path: string) => ({ notebook: "nb-1", path });
let root: Root | null = null;
let stop = () => {};
let el: HTMLElement;

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
async function mount() {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>); });
  await settle();
}
const body = () => el.querySelector<HTMLElement>(".pane-body")!;
const show = async (tabId: string) => { await act(async () => ws().activate("p0", tabId)); await settle(); };

beforeEach(() => {
  applyPaperDefault("theme", false);
  useWorkspace.setState({
    panes: [{ id: "p0", tabs: [
      { id: "read", kind: "file", file: file("A.md"), mode: "reading" },
      { id: "live", kind: "file", file: file("A.md"), mode: "live" },
      { id: "src", kind: "file", file: file("A.md"), mode: "source" },
      { id: "text", kind: "file", file: file("B.txt") },
      { id: "page", kind: "file", file: file("P.hmdoc") },
      { id: "note", kind: "note", ref: "d:1", mode: "reading" },
      { id: "new", kind: "new-note" },
      { id: "newfile", kind: "new-file" },
    ], active: "read" }],
    focused: "p0", dirty: {}, reveal: null,
  });
  useApp.setState({ route: { page: "notes" }, back: [] });
  docs.useDocuments.setState({ docs: {}, refs: {} });
  stop = startDocumentSync();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  stop();
  applyPaperDefault("theme", false);
});

const KINDS = ["read", "live", "src", "text", "page", "note", "new", "newfile"];

describe("the pane of a document tab", () => {
  it("is plain under the theme's background", async () => {
    await mount();
    for (const id of KINDS) {
      await show(id);
      expect([id, body().hasAttribute("data-paper")]).toEqual([id, false]);
    }
  });

  it("is white, whole, for every kind of document tab when the setting says white", async () => {
    await mount();
    await act(async () => applyPaperDefault("white", false));
    for (const id of KINDS) {
      await show(id);
      expect([id, body().hasAttribute("data-paper")]).toEqual([id, true]);
      // The page, its header and its status line are inside the marked pane body.
      expect(body().firstElementChild).not.toBeNull();
      expect(body().querySelector(".note-page, article.note")).not.toBeNull();
    }
    await show("read");
    expect(body().querySelector(".note-header")).not.toBeNull();
    expect(body().querySelector(".file-status")).not.toBeNull();
  });

  it("never marks the tab bar, the pane around it, the page or an empty pane", async () => {
    await mount();
    await act(async () => applyPaperDefault("white", false));
    expect(el.querySelectorAll("[data-paper]")).toHaveLength(1);
    expect(body().hasAttribute("data-paper")).toBe(true);
    expect(el.querySelector(".note-tabs")!.closest("[data-paper]")).toBeNull();
    expect(el.querySelector(".pane")!.hasAttribute("data-paper")).toBe(false);
    await act(async () => useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }] }));
    expect(el.querySelector("[data-paper]")).toBeNull();
  });

  it("follows the tab's own choice over the setting, in both directions", async () => {
    await mount();
    await act(async () => ws().updateTab("read", { paper: true }));
    expect(body().hasAttribute("data-paper")).toBe(true);
    await show("live");
    expect(body().hasAttribute("data-paper")).toBe(false);
    await act(async () => applyPaperDefault("white", false));
    expect(body().hasAttribute("data-paper")).toBe(true);
    await act(async () => ws().updateTab("live", { paper: false }));
    expect(body().hasAttribute("data-paper")).toBe(false);
  });

  it("marks each pane by its own tab", async () => {
    await mount();
    await act(async () => {
      useWorkspace.setState({ panes: [
        { id: "p0", tabs: [{ id: "a", kind: "note", ref: "d:1", paper: true }], active: "a" },
        { id: "p1", tabs: [{ id: "b", kind: "note", ref: "d:2" }], active: "b" },
      ] });
    });
    expect([...el.querySelectorAll(".pane-body")].map((b) => b.hasAttribute("data-paper"))).toEqual([true, false]);
  });
});

describe("open views are told when a pane changes background", () => {
  it("after the pane has its new marker, for a flip of the tab and for the setting, and not for a change that shows nothing new", async () => {
    await mount();
    const marked: boolean[] = [];
    const stop = onDocumentLook(() => marked.push(body().hasAttribute("data-paper")));
    await act(async () => ws().updateTab("read", { paper: true }));
    expect(marked).toEqual([true]);
    await act(async () => ws().updateTab("read", { paper: false }));
    expect(marked).toEqual([true, false]);
    await act(async () => ws().updateTab("read", { paper: undefined })); // back to following the setting: still the theme
    expect(marked).toEqual([true, false]);
    await act(async () => applyPaperDefault("white", false));
    expect(marked).toEqual([true, false, true]);
    await show("live");
    expect(marked).toEqual([true, false, true]); // white before and after
    await act(async () => ws().updateTab("live", { title: "Renamed" }));
    expect(marked).toEqual([true, false, true]);
    stop();
  });
});

describe("the page menu of a file tab", () => {
  const menu = async () => {
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Page actions"]')!.click());
    return () => [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((b) => b.textContent);
  };
  const choose = (label: string) => act(async () => [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!.click());

  it("offers White background under the theme, and flips only that tab", async () => {
    await mount();
    const items = await menu();
    expect(items()).toContain("White background");
    expect(items()).not.toContain("Theme background");
    await choose("White background");
    expect(ws().panes[0].tabs.find((t) => t.id === "read")!.paper).toBe(true);
    expect(ws().panes[0].tabs.filter((t) => t.paper !== undefined).map((t) => t.id)).toEqual(["read"]);
    expect(body().hasAttribute("data-paper")).toBe(true);
    expect((await menu())()).toContain("Theme background");
  });

  it("offers Theme background under a white setting, and flips back", async () => {
    await mount();
    await act(async () => applyPaperDefault("white", false));
    const items = await menu();
    expect(items()).toContain("Theme background");
    expect(items()).not.toContain("White background");
    await choose("Theme background");
    expect(ws().panes[0].tabs.find((t) => t.id === "read")!.paper).toBe(false);
    expect(body().hasAttribute("data-paper")).toBe(false);
  });
});
