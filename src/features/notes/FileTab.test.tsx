// @vitest-environment jsdom
// Notebook pages mounted for real (Codex re-review of c496e1c, T3, T4 and N6): two panes of one page through the
// file tab and its editor, the Try again button of a page that failed to open, and the tree's pointer dragging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const counts = { assetBase: 0 };
const sha = (text: string) => `sha-${text}`;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: "page" })), truncated: false };
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "file_save": {
        if (sha(files.get(path)!) !== (a.pre as { sha256: string }).sha256) return { status: "stale" };
        files.set(path, a.text as string);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "asset_base": counts.assetBase++; return `http://hmfile.localhost/g${counts.assetBase}/`;
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { EditorView } = await import("@codemirror/view");
const { FileTab } = await import("./FileTab");
const { NewFileTab } = await import("./NewFileTab");
const { untitledText } = await import("./untitled");
const { useRowDrag } = await import("./NotebookTree");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { draftKeyOf } = await import("../../documents/keys");

const ref = (path: string) => ({ notebook: "nb-1", path });
const ws = () => useWorkspace.getState();
let root: Root | null = null;
let stop = () => {};

async function mount(node: ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>); });
  return el;
}

/** Let reads, writes and React settle. */
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

describe("notebook pages, mounted", () => {
  beforeEach(() => {
    files.clear(); drafts.clear();
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useApp.setState({ route: { page: "notes" }, back: [] });
    docs.useDocuments.setState({ docs: {}, refs: {} });
    stop = startDocumentSync();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    stop();
  });

  it("T4: typing in two panes of one page keeps both edits in the editors and in the saved file", async () => {
    files.set("A.md", "alpha\n");
    ws().openTab({ kind: "file", file: ref("A.md"), mode: "source" });
    ws().openTab({ kind: "file", file: ref("A.md"), mode: "source" }, { split: true });
    const [left, right] = ws().panes.map((p) => p.tabs[0]);
    const el = await mount(<><FileTab tab={left} /><FileTab tab={right} /></>);
    await settle();
    const views = [...el.querySelectorAll<HTMLElement>(".cm-content")].map((c) => EditorView.findFromDOM(c)!);
    expect(views).toHaveLength(2);
    const type = (v: InstanceType<typeof EditorView>, text: string) =>
      act(() => { v.dispatch({ changes: { from: v.state.doc.length, insert: text }, userEvent: "input.type" }); });
    await type(views[0], "left\n");
    await type(views[1], "right\n");
    expect(views[0].state.doc.toString()).toBe("alpha\nleft\nright\n");
    expect(views[1].state.doc.toString()).toBe("alpha\nleft\nright\n");
    await act(async () => { await docs.save(docs.keyOf(ref("A.md"))); });
    expect(files.get("A.md")).toBe("alpha\nleft\nright\n");
  });

  it("D1: an untitled file keeps its text when its tab is shown again, and forgets it when the tab closes", async () => {   // Codex review of 52051c8
    ws().openTab({ kind: "new-file" });
    const tab = ws().panes[0].tabs[0];
    let el = await mount(<NewFileTab tab={tab} />);
    const view = () => EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-content")!)!;
    await act(() => { view().dispatch({ changes: { from: 0, insert: "kept text" }, userEvent: "input.type" }); });
    expect(ws().dirty[tab.id]).toBe(true);
    // Another tab of the pane is shown, then this one again: the view mounts afresh.
    await act(async () => root!.unmount());
    el = await mount(<NewFileTab tab={tab} />);
    expect(view().state.doc.toString()).toBe("kept text");
    await act(async () => { ws().closeTab("p0", tab.id); });
    expect(untitledText(tab.id)).toBe("");
  });

  it("A3: a page asks for its picture address each time it opens, so a withdrawn grant is never reused", async () => {   // Codex review of 52051c8
    files.set("Pic.md", "![x](a.png)\n");
    ws().openTab({ kind: "file", file: ref("Pic.md"), mode: "source" });
    // The app's own defaults (src/main.tsx), whose 30-second staleTime would reuse a withdrawn grant (re-review of fa08348).
    const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } } });
    const show = async () => {
      const el = document.createElement("div");
      document.body.append(el);
      root = createRoot(el);
      await act(async () => { root!.render(<QueryClientProvider client={client}><FileTab tab={ws().panes[0].tabs[0]} /></QueryClientProvider>); });
      await settle();
    };
    const before = counts.assetBase;
    await show();
    expect(counts.assetBase).toBe(before + 1);
    await act(async () => root!.unmount());
    await show();
    expect(counts.assetBase).toBe(before + 2);
  });

  it("T3: Try again on a page that failed to open keeps its draft and shows the edits", async () => {
    const key = await draftKeyOf(docs.keyOf(ref("Later.md")));
    drafts.set(key, {
      key, kind: "file", target: ref("Later.md"), precondition: { sha256: sha("x"), size: 1, mtimeMs: 1 },
      format: { encoding: "UTF-8", bom: false, eol: "lf" }, base: "x", mine: "x and my edit", savedAt: "t",
    });
    ws().openTab({ kind: "file", file: ref("Later.md"), mode: "source" });
    const el = await mount(<FileTab tab={ws().panes[0].tabs[0]} />);
    await settle();
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(retry).toBeTruthy();
    files.set("Later.md", "x");
    await act(async () => { retry!.click(); });
    await settle();
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("Later.md"))]).toMatchObject({ status: "dirty", text: "x and my edit" });
    expect(drafts.has(key)).toBe(true);
  });

  it("N6: a second pointer pressed during a drag neither takes over nor ends it", async () => {
    const drops: string[] = [];
    const nodes = new Map([["a.md", { path: "A.md", kind: "page" }], ["b.md", { path: "B.md", kind: "page" }], ["dir", { path: "Dir", kind: "dir" }]]);
    let api: ReturnType<typeof useRowDrag> | null = null;
    function Rows() {
      const drag = useRowDrag("nb-1", (from, target) => drops.push(`${from} -> ${target?.path ?? "top"}`), nodes as never);
      useEffect(() => { api = drag; });
      return (
        <div data-tree-root="nb-1">
          {["A.md", "B.md", "Dir"].map((p) => <div key={p} data-tree-path={p} onPointerDown={(e) => drag.down(p, e)}>{p}</div>)}
        </div>
      );
    }
    const el = await mount(<Rows />);
    const row = (p: string) => el.querySelector<HTMLElement>(`[data-tree-path="${p}"]`)!;
    const pointer = (target: EventTarget, type: string, pointerId: number, x: number, y: number) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(e, "pointerId", { value: pointerId });
      return act(() => { target.dispatchEvent(e); });
    };
    document.elementFromPoint = () => row("Dir");
    await pointer(row("A.md"), "pointerdown", 1, 0, 0);
    await pointer(window, "pointermove", 1, 0, 40);
    expect(api!.drag).toMatchObject({ path: "A.md", over: "Dir" });
    // A second finger presses another row and lifts: the first drag is still A.md's and nothing dropped.
    await pointer(row("B.md"), "pointerdown", 2, 0, 20);
    await pointer(window, "pointerup", 2, 0, 20);
    expect(drops).toEqual([]);
    expect(api!.drag).toMatchObject({ path: "A.md" });
    await pointer(window, "pointerup", 1, 0, 40);
    expect(drops).toEqual(["A.md -> Dir"]);
  });
});
