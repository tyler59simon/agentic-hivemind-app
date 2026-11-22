// @vitest-environment jsdom
// NS-7C: a `.canvas` file in its tab. It opens as a board with Board, Source and History tabs; looking at it writes nothing;
// an edit on the board goes through the document session (unsaved edits kept, the hash of the file as the precondition on
// save, every unknown field kept); a file the board cannot hold opens as Source with the reason and is never written; a
// conflict is Keep mine, Keep theirs or Save both; pictures load through the notebook's grant.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const sha = (text: string) => `sha-${text.length}-${text.slice(0, 40)}-${text.slice(-40)}`;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    calls.push({ cmd, args: a });
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: /\.(md|hmdoc)$/.test(p) ? "page" : /\.canvas$/.test(p) ? "text" : "other" })), truncated: false };
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: files.get(path)!.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "file_save": {
        if (sha(files.get(path)!) !== (a.pre as { sha256: string }).sha256) return { status: "stale" };
        files.set(path, a.text as string);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "file_create":
        if (files.has(path)) throw new Error(`${path} already exists`);
        files.set(path, a.text as string);
        return { sha256: sha(a.text as string), size: 1, mtimeMs: 1 };
      case "asset_base": return "http://hmfile.localhost/g1/";
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("./FileTab");
const actions = await import("./actions");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { parseCanvas, writeCanvas } = await import("../canvas/model");

const ref = (path: string) => ({ notebook: "nb-1", path });
const key = (path: string) => docs.keyOf(ref(path));
const ws = () => useWorkspace.getState();
let root: Root | null = null;
let stop = () => {};

async function mount(node: ReactNode, client = new QueryClient()) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>); });
  return el;
}
async function until(what: () => unknown, label = "the page") {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}
const fire = (el: Element | Window, e: Event) => act(async () => { el.dispatchEvent(e); });
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const point = (type: string, x: number, y: number) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true }), { pointerId: 1 });
const button = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const cardOf = (el: ParentNode, id: string) => el.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
const tabs = (el: ParentNode) => [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const saves = () => calls.filter((c) => c.cmd === "file_save");

async function dragCard(el: ParentNode, id: string, dx: number, dy: number) {
  await fire(cardOf(el, id), point("pointerdown", 10, 10));
  for (let i = 1; i <= 8; i++) await fire(window, point("pointermove", 10 + (dx * i) / 8, 10 + (dy * i) / 8));
  await fire(window, point("pointerup", 10 + dx, 10 + dy));
}

/** What Obsidian writes, with fields this code does not know. */
const OBSIDIAN = `{
\t"nodes":[
\t\t{"id":"a","type":"text","text":"card a","x":0,"y":0,"width":200,"height":80,"color":"2","obsidianOnly":{"k":[1,2]}},
\t\t{"id":"b","type":"file","file":"pic.png","x":300,"y":0,"width":320,"height":240},
\t\t{"id":"c","type":"link","url":"https://example.com/x","x":0,"y":200,"width":200,"height":100}
\t],
\t"edges":[
\t\t{"id":"e1","fromNode":"a","fromSide":"right","toNode":"b","toSide":"left","label":"see","edgeExtra":true}
\t],
\t"metadata":{"version":"1.0-1.0"}
}`;

/** Open `path` in a tab and show the board. */
async function open(path: string, mode: "board" | "source" = "board") {
  ws().openTab({ kind: "file", file: ref(path), mode });
  const el = await mount(<FileTab tab={ws().panes[0].tabs[0]} />);
  await until(() => el.querySelector(".canvas-board, .cm-content, .center.error"), path);
  return el;
}

beforeEach(() => {
  files.clear(); drafts.clear(); calls.length = 0;
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

describe("a canvas in its tab", () => {
  it("opens as a board with Board, Source and History, loads its picture through the grant, and writes nothing", async () => {
    files.set("Plan.canvas", OBSIDIAN);
    files.set("pic.png", "x");
    const el = await open("Plan.canvas");
    expect(tabs(el)).toEqual(["Board", "Source", "History"]);
    expect(el.querySelectorAll(".canvas-node")).toHaveLength(3);
    await until(() => el.querySelector("img"), "the picture");
    expect(el.querySelector("img")!.getAttribute("src")).toBe("http://hmfile.localhost/g1/pic.png");
    expect(el.querySelector(".canvas-text")?.textContent).toContain("card a");
    expect(el.querySelector(".canvas-edge-label")?.textContent).toBe("see");
    expect(document.querySelector("iframe")).toBeNull();
    // Selecting, panning and zooming are not edits.
    await fire(cardOf(el, "a"), point("pointerdown", 10, 10));
    await fire(window, point("pointerup", 10, 10));
    await click(button(el, "+"));
    expect(docs.useDocuments.getState().docs[key("Plan.canvas")].status).toBe("clean");
    expect(saves()).toHaveLength(0);
    expect(files.get("Plan.canvas")).toBe(OBSIDIAN);
  });

  it("an edit on the board goes through the session, and Save writes it against the hash of the file with every field kept", async () => {
    files.set("Plan.canvas", OBSIDIAN);
    files.set("pic.png", "x");
    const el = await open("Plan.canvas");
    await dragCard(el, "a", 40, 20);
    const doc = () => docs.useDocuments.getState().docs[key("Plan.canvas")];
    expect(doc().status).toBe("dirty");
    expect(saves()).toHaveLength(0);
    expect(files.get("Plan.canvas")).toBe(OBSIDIAN);
    await click(button(el, "Save"));
    await until(() => saves().length === 1, "the save");
    expect((saves()[0].args.pre as { sha256: string }).sha256).toBe(sha(OBSIDIAN));
    const saved = parseCanvas(files.get("Plan.canvas")!);
    const before = parseCanvas(OBSIDIAN);
    expect(saved.ok && before.ok).toBe(true);
    if (!saved.ok || !before.ok) return;
    expect(saved.canvas.nodes[0]).toEqual({ ...before.canvas.nodes[0], x: 40, y: 20 });
    expect(saved.canvas.nodes.slice(1)).toEqual(before.canvas.nodes.slice(1));
    expect(saved.canvas.edges).toEqual(before.canvas.edges);
    expect(saved.canvas.extra).toEqual([["metadata", { version: "1.0-1.0" }]]);
    expect(files.get("Plan.canvas")).toBe(writeCanvas(saved.canvas));
    await until(() => doc().status === "clean", "the saved page");
  });

  it("keeps edits that were already unsaved: a change on the board is made on top of them", async () => {
    files.set("Plan.canvas", OBSIDIAN);
    files.set("pic.png", "x");
    const el = await open("Plan.canvas");
    // Typed elsewhere (the source tab of another pane, say), not saved yet: a card added to the text.
    const before = parseCanvas(OBSIDIAN);
    if (!before.ok) throw new Error("fixture");
    const withExtra = writeCanvas({ ...before.canvas, nodes: [...before.canvas.nodes, { id: "z", type: "text", text: "unsaved card", x: 500, y: 500, width: 100, height: 50 }] });
    await act(async () => { docs.edit(key("Plan.canvas"), withExtra, true); });
    await until(() => cardOf(el, "z"), "the card typed elsewhere");
    await dragCard(el, "a", 10, 10);
    const text = docs.useDocuments.getState().docs[key("Plan.canvas")].text;
    const now = parseCanvas(text);
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.canvas.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "z"]);
    expect(now.canvas.nodes[0]).toMatchObject({ x: 10, y: 10 });
    expect(now.canvas.nodes[3]).toMatchObject({ text: "unsaved card" });
    expect(saves()).toHaveLength(0);
  });

  it("Undo goes back one gesture through the session, and the page is clean again at the start", async () => {
    files.set("Plan.canvas", OBSIDIAN);
    files.set("pic.png", "x");
    const el = await open("Plan.canvas");
    await dragCard(el, "a", 40, 20);
    await dragCard(el, "c", 5, 5);
    const doc = () => docs.useDocuments.getState().docs[key("Plan.canvas")];
    await click(button(el, "Undo"));
    expect(parseCanvas(doc().text)).toMatchObject({ ok: true, canvas: { nodes: [{ x: 40, y: 20 }, {}, { x: 0, y: 200 }] } });
    await click(button(el, "Undo"));
    expect(doc().text).toBe(OBSIDIAN);
    expect(doc().status).toBe("clean");
  });

  it("a canvas that is not valid opens as Source with the reason, and nothing is written", async () => {
    const bad = '{"nodes":[{"id":"a","type":"text","x":0}]}';
    files.set("Bad.canvas", bad);
    const el = await open("Bad.canvas");
    await until(() => el.querySelector(".cm-content"), "the source");
    expect(el.querySelector(".canvas-board")).toBeNull();
    expect(el.textContent).toContain("This canvas cannot be shown as a board: Node \"a\" has no number for y");
    expect(el.textContent).toContain("nothing was written");
    expect(tabs(el)).toEqual(["Board", "Source", "History"]);
    expect(ws().panes[0].tabs[0].mode).toBe("source");
    expect(saves()).toHaveLength(0);
    expect(calls.some((c) => c.cmd === "file_create")).toBe(false);
    expect(files.get("Bad.canvas")).toBe(bad);
    expect(docs.useDocuments.getState().docs[key("Bad.canvas")].status).toBe("clean");
  });

  it("text that is not JSON, and a list at the top, are refused the same way", async () => {
    for (const [name, text] of [["Text.canvas", "hello"], ["List.canvas", "[]"]] as const) {
      files.set(name, text);
      docs.useDocuments.setState({ docs: {}, refs: {} });
      useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
      await act(async () => root?.unmount());
      document.body.innerHTML = "";
      const el = await open(name);
      await until(() => el.querySelector(".cm-content"), name);
      expect(el.textContent).toContain("This canvas cannot be shown as a board");
      expect(files.get(name)).toBe(text);
    }
    expect(saves()).toHaveLength(0);
  });

  it("a blank file is an empty board and stays unwritten until something is added", async () => {
    files.set("Empty.canvas", "");
    const el = await open("Empty.canvas");
    expect(el.querySelector(".canvas-board")).not.toBeNull();
    expect(saves()).toHaveLength(0);
    expect(docs.useDocuments.getState().docs[key("Empty.canvas")].status).toBe("clean");
    await click(button(el, "Text"));
    expect(docs.useDocuments.getState().docs[key("Empty.canvas")].status).toBe("dirty");
  });

  it("a change on disk while there are unsaved edits is Keep mine, Keep theirs or Save both, never a line merge", async () => {
    files.set("Plan.canvas", OBSIDIAN);
    files.set("pic.png", "x");
    const el = await open("Plan.canvas");
    await dragCard(el, "a", 40, 20);
    const theirs = OBSIDIAN.replace('"card a"', '"card a edited elsewhere"');
    files.set("Plan.canvas", theirs);
    await act(async () => { await docs.refresh("nb-1", ["Plan.canvas"]); });
    await until(() => button(el, "Keep mine"), "the conflict banner");
    expect(button(el, "Keep theirs")).not.toBeNull();
    expect(button(el, "Save both")).not.toBeNull();
    expect(button(el, "Merge")).toBeNull();
    await click(button(el, "Save both"));
    await until(() => files.has("Plan (my edits).canvas"), "the copy");
    const mine = parseCanvas(files.get("Plan (my edits).canvas")!);
    expect(mine.ok && mine.canvas.nodes[0]).toMatchObject({ x: 40, y: 20 });
  });
});

describe("making and opening a canvas", () => {
  it("New canvas makes Untitled.canvas with no cards and opens it as a board; a second one takes a free name", async () => {
    const client = new QueryClient();
    expect(await actions.newCanvas(client, "nb-1")).toBe("Untitled.canvas");
    expect(files.get("Untitled.canvas")).toBe('{"nodes":[],"edges":[]}');
    expect(ws().panes[0].tabs[0]).toMatchObject({ kind: "file", mode: "board", file: { notebook: "nb-1", path: "Untitled.canvas" } });
    expect(await actions.newCanvas(client, "nb-1", "Sub")).toBe("Sub/Untitled.canvas");
    expect(await actions.newCanvas(client, "nb-1")).toBe("Untitled 2.canvas");
    await expect(actions.newCanvas(client, "lm:demo:plans")).rejects.toThrow(/Living Memory notebooks hold Markdown pages only/);
  });

  it("opening a canvas from the tree or a link shows the board, and a split of its tab shows a board too", async () => {
    actions.openPage(ref("Plan.canvas"));
    expect(ws().panes[0].tabs[0].mode).toBe("board");
    actions.openPage(ref("notes.txt"));
    expect(ws().panes[0].tabs[1].mode).toBe("source");
  });
});
