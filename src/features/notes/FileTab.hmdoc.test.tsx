// @vitest-environment jsdom
// NS-3C: a `.hmdoc` page in its tab, and the tree and actions around it. A rich page has no modes; a file the editor
// cannot hold opens as read-only JSON with the reason; a conflict is Keep mine, Keep theirs or Save both; New rich page,
// Convert to rich page and Export to Markdown make files beside the page; none of it is offered in Living Memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror and ProseMirror measure text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
/** Holds file_create until a test opens it. */
const gates = { create: null as Promise<void> | null };
const sha = (text: string) => `sha-${text.length}-${text.slice(0, 40)}-${text.slice(-40)}`;
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: /\.(md|hmdoc)$/.test(p) ? "page" : "other" })), truncated: false };
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: files.get(path)!.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "file_save": {
        if (sha(files.get(path)!) !== (a.pre as { sha256: string }).sha256) return { status: "stale" };
        files.set(path, a.text as string);
        return { status: "saved", sha256: sha(a.text as string), size: 1, mtimeMs: 2 };
      }
      case "file_create":
        await gates.create;
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
const { EditorView } = await import("@codemirror/view");
const { FileTab } = await import("./FileTab");
const { NotebookTree } = await import("./NotebookTree");
const actions = await import("./actions");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { newPageText, stringifyEnvelope } = await import("../hmdoc/envelope");
const { isRichDoc, pageTitle } = await import("../../lib/notebooks");
const { buildTree, ancestors } = await import("./tree");
const { resolvePage } = await import("../links/resolve");

const ref = (path: string) => ({ notebook: "nb-1", path });
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

/** Wait for `what` to be true, letting reads, writes, lazy chunks and React settle meanwhile. */
async function until(what: () => unknown, label = "the page") {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const hmdoc = (...blocks: unknown[]) => stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta: { title: "Plan" }, content: { type: "doc", content: blocks } } as never);
const button = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const item = (text: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.trim() === text) ?? null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const typed = (el: HTMLElement) => (el.querySelector(".rich-doc") as HTMLElement & { editor: import("@tiptap/core").Editor }).editor;

/** Open `path` in a tab and show it. */
async function open(path: string, client?: InstanceType<typeof QueryClient>) {
  ws().openTab({ kind: "file", file: ref(path), mode: "source" });
  const el = await mount(<FileTab tab={ws().panes[0].tabs[0]} />, client);
  await until(() => el.querySelector(".rich-doc, .cm-content, .center.error, .card"), path);
  return el;
}

describe("rich pages in their tab", () => {
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

  it("a rich page opens in the page editor with no mode tabs, and opening writes nothing", async () => {
    files.set("Plan.hmdoc", hmdoc(para("Hello")));
    const saves = vi.spyOn(docs, "save");
    const el = await open("Plan.hmdoc");
    expect(typed(el).state.doc.textContent).toBe("Hello");
    expect(el.querySelector('[aria-label="Page view"]')).toBeNull();
    expect(el.querySelector("h1")!.textContent).toBe("Plan");
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("Plan.hmdoc"))].status).toBe("clean");
    expect(files.get("Plan.hmdoc")).toBe(hmdoc(para("Hello")));
    expect(saves).not.toHaveBeenCalled();
  });

  it("typing changes the session's text to the file in the stable order, and Save writes it", async () => {
    files.set("Plan.hmdoc", hmdoc(para("Hello")));
    const el = await open("Plan.hmdoc");
    const editor = typed(el);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText("!", editor.state.doc.content.size - 1)); });
    const key = docs.keyOf(ref("Plan.hmdoc"));
    expect(docs.useDocuments.getState().docs[key].status).toBe("dirty");
    await act(async () => { await docs.save(key); });
    const saved = files.get("Plan.hmdoc")!;
    expect(saved).toBe(hmdoc(para("Hello!")));
    expect(saved.startsWith('{\n  "content"')).toBe(true);
  });

  it("a file the editor cannot hold opens as read-only JSON with the reason, and a newer one says so", async () => {
    files.set("Newer.hmdoc", JSON.stringify({ schemaVersion: 2, format: "hivemind-rich", meta: {}, content: { type: "doc", content: [] } }, null, 1));
    const el = await open("Newer.hmdoc");
    expect(el.querySelector(".rich-doc")).toBeNull();
    expect(el.querySelector(".banner")!.textContent).toContain("Made by a newer Hivemind");
    expect(el.querySelector(".cm-content")!.textContent).toContain('"schemaVersion": 2');
    expect(EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-content")!)!.state.readOnly).toBe(true);
  });

  it("unknown nodes and text that is not JSON open read-only too", async () => {
    files.set("Odd.hmdoc", hmdoc({ type: "sparkline" }));
    files.set("Broken.hmdoc", "{ not json");
    const el = await open("Odd.hmdoc");
    expect(el.querySelector(".banner")!.textContent).toContain('unknown node "sparkline"');
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    ws().openTab({ kind: "file", file: ref("Broken.hmdoc"), mode: "source" }, { split: true });
    const el2 = await mount(<FileTab tab={ws().panes[1].tabs[0]} />);
    await until(() => el2.querySelector(".banner"));
    expect(el2.querySelector(".banner")!.textContent).toContain("not valid JSON");
    expect(el2.querySelector(".rich-doc")).toBeNull();
  });

  it("a file over 5,000,000 characters opens as read-only JSON", async () => {
    files.set("Big.hmdoc", `${"x".repeat(99)}\n`.repeat(50_001));
    const el = await open("Big.hmdoc");
    expect(el.querySelector(".banner")!.textContent).toContain("5,000,000 characters");
    expect(el.querySelector(".rich-doc")).toBeNull();
  });

  /** Edit the open page, change the file on disk, and try to save: the page is stale. */
  async function conflict(path = "Plan.hmdoc") {
    files.set(path, hmdoc(para("Hello")));
    const el = await open(path);
    const editor = typed(el);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText(" mine", editor.state.doc.content.size - 1)); });
    files.set(path, hmdoc(para("Hello theirs")));
    await act(async () => { await docs.save(docs.keyOf(ref(path))); });
    await until(() => button(el, "Keep mine"), "the conflict buttons");
    return el;
  }

  it("a conflict offers Keep mine, Keep theirs and Save both, and no merge", async () => {
    const el = await conflict();
    expect(button(el, "Merge")).toBeNull();
    expect(button(el, "Keep theirs")).toBeTruthy();
    expect(button(el, "Save both")).toBeTruthy();
    expect(el.querySelector(".banner.warn")!.textContent).toContain("changed on disk");
  });

  it("Keep mine saves my text over the version shown", async () => {
    const el = await conflict();
    await click(button(el, "Keep mine"));
    await until(() => files.get("Plan.hmdoc") === hmdoc(para("Hello mine")), "my version on disk");
    expect(button(el, "Keep mine")).toBeNull();
  });

  it("Keep theirs drops my edits and shows the file", async () => {
    const el = await conflict();
    await click(button(el, "Keep theirs"));
    await until(() => typed(el).state.doc.textContent === "Hello theirs", "their version");
    expect(files.get("Plan.hmdoc")).toBe(hmdoc(para("Hello theirs")));
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("Plan.hmdoc"))].status).toBe("clean");
  });

  it("R1-4: Save both keeps what was typed while the copy was being made, and does not reload over it", async () => {
    const el = await conflict();
    let open = () => {};
    gates.create = new Promise<void>((resolve) => { open = resolve; });
    await click(button(el, "Save both"));
    const editor = typed(el);
    await act(async () => { editor.view.dispatch(editor.state.tr.insertText(" and more", editor.state.doc.content.size - 1)); });
    gates.create = null;
    await act(async () => { open(); });
    await until(() => files.has("Plan (my edits).hmdoc"), "the copy");
    await settle();
    expect(files.get("Plan (my edits).hmdoc")).toBe(hmdoc(para("Hello mine")));
    const state = docs.useDocuments.getState().docs[docs.keyOf(ref("Plan.hmdoc"))];
    expect(state.text).toContain("Hello mine and more");
    expect(typed(el).state.doc.textContent).toBe("Hello mine and more");
    expect(state.status === "dirty" || state.status === "stale").toBe(true);
  });

  it("Save both puts my version beside the page under a free name, then shows the file", async () => {
    files.set("Plan (my edits).hmdoc", "taken");
    const el = await conflict();
    await click(button(el, "Save both"));
    await until(() => files.has("Plan (my edits) 2.hmdoc"), "the copy");
    expect(files.get("Plan (my edits) 2.hmdoc")).toBe(hmdoc(para("Hello mine")));
    expect(files.get("Plan (my edits).hmdoc")).toBe("taken");
    expect(files.get("Plan.hmdoc")).toBe(hmdoc(para("Hello theirs")));
    await until(() => typed(el).state.doc.textContent === "Hello theirs", "their version");
  });

  it("R1-16: following a missing [[Plan.hmdoc]] makes a valid rich page, and a missing Markdown page stays empty", async () => {
    files.set("Index.md", "See [[Plan.hmdoc]] and [[Notes]].\n");
    ws().openTab({ kind: "file", file: ref("Index.md"), mode: "reading" });
    const el = await mount(<FileTab tab={ws().panes[0].tabs[0]} />);
    await until(() => el.querySelector("a.wikilink"), "the links");
    const link = (name: string) => [...el.querySelectorAll("a.wikilink")].find((a) => a.textContent === name)!;
    await click(link("Plan.hmdoc"));
    await click(button(document.body, "Create page"));
    await until(() => files.has("Plan.hmdoc"), "the rich page");
    expect(files.get("Plan.hmdoc")).toBe(newPageText("Plan"));
    const { inspect } = await import("../hmdoc/validate");
    expect(inspect(files.get("Plan.hmdoc")!).ok).toBe(true);
    await click(link("Notes"));
    await click(button(document.body, "Create page"));
    await until(() => files.has("Notes.md"), "the Markdown page");
    expect(files.get("Notes.md")).toBe("");
  });

  it("R1-16: a rich page is not made for a missing link in a Living Memory notebook", async () => {
    expect(actions.missingPageProblem("lm:demo:plans", "Plan.hmdoc")).toContain("Markdown pages only");
    expect(actions.missingPageProblem("lm:demo:plans", "Plan.md")).toBeNull();
    expect(actions.missingPageProblem("nb-1", "Plan.hmdoc")).toBeNull();
    await expect(actions.createMissingPage("lm:demo:plans", "Plan.hmdoc")).rejects.toThrow("Markdown pages only");
  });

  it("R1-18: a cover named 100% complete.png is drawn from its literal name", async () => {
    files.set("100% complete.png", "png");
    files.set("Plan.hmdoc", stringifyEnvelope({
      schemaVersion: 1, format: "hivemind-rich", meta: { cover: "100% complete.png" }, content: { type: "doc", content: [para("x")] },
    } as never));
    const el = await open("Plan.hmdoc");
    await until(() => el.querySelector(".hmdoc-cover img"), "the cover");
    expect(el.querySelector(".hmdoc-cover img")!.getAttribute("src")).toBe("http://hmfile.localhost/g1/100%25%20complete.png");
  });

  it("the page's menu exports a rich page to Markdown and reports what was dropped", async () => {
    files.set("Plan.hmdoc", stringifyEnvelope({
      schemaVersion: 1, format: "hivemind-rich", meta: { width: "full" },
      content: { type: "doc", content: [para("Hello"), { type: "toggle", attrs: { open: true }, content: [{ type: "toggleSummary", content: [{ type: "text", text: "More" }] }, para("Hidden")] }] },
    } as never));
    const el = await open("Plan.hmdoc");
    await click(el.querySelector('[aria-label="Page actions"]'));
    expect(item("Convert to rich page")).toBeNull();
    await click(item("Export to Markdown…"));
    await until(() => document.querySelector('[role="dialog"][aria-label="Exported to Markdown"]'), "the report");
    const dialog = document.querySelector('[role="dialog"][aria-label="Exported to Markdown"]')!;
    expect(files.get("Plan.md")).toBe("Hello\n\n> [!note]- More\n> Hidden\n");
    expect(dialog.textContent).toContain("Plan.md");
    const lines = [...dialog.querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(["Toggles (written as folded callouts with the summary as the title): 1", "Page width: 1"]);
    // The Markdown page is opened on request, not by itself.
    expect(ws().panes[0].tabs.map((t) => t.file?.path)).toEqual(["Plan.hmdoc"]);
    await click(button(dialog, "Open the Markdown page"));
    expect(ws().panes[0].tabs.map((t) => t.file?.path)).toEqual(["Plan.hmdoc", "Plan.md"]);
  });

  it("a rich page that cannot be exported says why and writes nothing", async () => {
    files.set("Odd.hmdoc", "{ not json");
    const el = await open("Odd.hmdoc");
    await click(el.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to Markdown…"));
    await settle();
    expect(files.has("Odd.md")).toBe(false);
  });

  it("the page's menu converts a Markdown page to a rich page beside it and opens it", async () => {
    files.set("Plan.md", "# Plan\n\nSome *text*.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    const el = await open("Plan.md");
    await click(el.querySelector('[aria-label="Page actions"]'));
    expect(item("Export to Markdown…")).toBeNull();
    await click(item("Convert to rich page"));
    await until(() => files.has("Plan.hmdoc"), "the rich page");
    expect(files.get("Plan.md")).toBe("# Plan\n\nSome *text*.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    const made = JSON.parse(files.get("Plan.hmdoc")!);
    expect(made.meta).toEqual({ title: "Plan" });
    expect(made.content.content.map((b: { type: string }) => b.type)).toEqual(["heading", "paragraph", "table"]);
    expect(ws().panes[0].tabs.map((t) => t.file?.path)).toEqual(["Plan.md", "Plan.hmdoc"]);
  });
});

describe("new rich page, convert and export", () => {
  beforeEach(() => {
    files.clear(); drafts.clear();
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    docs.useDocuments.setState({ docs: {}, refs: {} });
  });

  it("New rich page makes Untitled.hmdoc with one empty paragraph, under a free name, and opens it", async () => {
    const client = new QueryClient();
    const first = await actions.newRichPage(client, "nb-1", "Projects");
    expect(first).toBe("Projects/Untitled.hmdoc");
    expect(files.get(first)).toBe(newPageText("Untitled"));
    const second = await actions.newRichPage(client, "nb-1", "Projects");
    expect(second).toBe("Projects/Untitled 2.hmdoc");
    expect(JSON.parse(files.get(second)!).meta).toEqual({ title: "Untitled 2" });
    expect(ws().panes[0].tabs.map((t) => t.file?.path)).toEqual(["Projects/Untitled.hmdoc", "Projects/Untitled 2.hmdoc"]);
    expect(files.size).toBe(2);
  });

  it("Convert and Export take a free name beside the page, and leave the page alone", async () => {
    const client = new QueryClient();
    files.set("A/Note.md", "Text\n");
    files.set("A/Note.hmdoc", "taken");
    const path = await actions.convertToRich(client, ref("A/Note.md"));
    expect(path).toBe("A/Note 2.hmdoc");
    expect(files.get("A/Note.md")).toBe("Text\n");
    expect(files.get("A/Note.hmdoc")).toBe("taken");
    files.set("A/Plan.hmdoc", hmdoc(para("Body")));
    files.set("A/Plan.md", "taken");
    const out = await actions.exportToMarkdown(client, ref("A/Plan.hmdoc"));
    expect(out.path).toBe("A/Plan 2.md");
    expect(files.get("A/Plan 2.md")).toBe("Body\n");
    expect(out.report).toEqual([]);
  });

  it("an open page is converted and exported as it is now, unsaved edits included", async () => {
    const client = new QueryClient();
    files.set("Note.md", "Saved\n");
    await docs.open(ref("Note.md"));
    docs.edit(docs.keyOf(ref("Note.md")), "Edited\n");
    await actions.convertToRich(client, ref("Note.md"));
    expect(JSON.stringify(JSON.parse(files.get("Note.hmdoc")!).content)).toContain("Edited");
  });

  it("Living Memory notebooks hold Markdown pages only", async () => {
    const client = new QueryClient();
    await expect(actions.newRichPage(client, "lm:demo:plans")).rejects.toThrow("Markdown pages only");
    await expect(actions.convertToRich(client, { notebook: "lm:demo:plans", path: "A.md" }, "x")).rejects.toThrow("Markdown pages only");
    await expect(actions.exportToMarkdown(client, { notebook: "lm:demo:plans", path: "A.hmdoc" }, "x")).rejects.toThrow("Markdown pages only");
    await expect(actions.saveBothVersions(client, { notebook: "lm:demo:plans", path: "A.hmdoc" }, "x")).rejects.toThrow("Markdown pages only");
  });
});

describe("the tree", () => {
  const entries = (...paths: string[]) => paths.map((path) => ({ path, kind: /\.(md|markdown|hmdoc)$/.test(path) ? "page" as const : "dir" as const, size: 0, mtimeMs: 0 }));

  it("treats Name.hmdoc as a page: titles, subpages, revealing and links", () => {
    expect(isRichDoc("A/Plan.hmdoc")).toBe(true);
    expect(isRichDoc("A/Plan.HMDOC")).toBe(true);
    expect(isRichDoc("A/Plan.md")).toBe(false);
    expect(pageTitle("A/Plan.hmdoc")).toBe("Plan");
    expect(pageTitle("A/Plan.md")).toBe("Plan");
    const tree = buildTree(entries("Plan.hmdoc", "Plan", "Plan/Step.md", "Other.md"));
    expect(tree.map((n) => n.name)).toEqual(["Other.md", "Plan.hmdoc"]);
    expect(tree[1].children.map((n) => n.path)).toEqual(["Plan/Step.md"]);
    expect(ancestors("Plan/Step.md")).toContain("plan.hmdoc");
    expect(resolvePage("Plan", ref("Other.md"), ["Other.md", "Plan.hmdoc"])).toEqual({ ref: ref("Plan.hmdoc") });
    expect(resolvePage("Plan.hmdoc", ref("Other.md"), ["Other.md", "Plan.hmdoc"])).toEqual({ ref: ref("Plan.hmdoc") });
    // A page made by following a missing link is still Markdown.
    expect(resolvePage("New page", ref("Other.md"), ["Other.md"])).toEqual({ missing: "New page.md" });
  });

  it("R2-4: with Plan.md and Plan.markdown, the subpages stay with Plan.md as before, and revealing one expands it", () => {
    const list = ["Plan", "Plan.markdown", "Plan.md", "Plan/Sub.md"];
    for (const order of [list, [...list].reverse()]) {
      const tree = buildTree(entries(...order));
      const owner = tree.find((n) => n.children.length > 0)!;
      expect(owner.name).toBe(order === list ? "Plan.md" : "Plan.markdown");
    }
    // As Rust lists them (by lower-case name), Plan.md comes last, so it holds the folder, and ancestors() opens its row.
    const tree = buildTree(entries(...list));
    expect(tree.find((n) => n.name === "Plan.md")!.children.map((n) => n.path)).toEqual(["Plan/Sub.md"]);
    expect(ancestors("Plan/Sub.md")).toContain("plan.md");
    // A rich page still never takes the folder from a Markdown one, in either order.
    for (const order of [["Plan.hmdoc", "Plan.markdown", "Plan", "Plan/Sub.md"], ["Plan.markdown", "Plan.hmdoc", "Plan", "Plan/Sub.md"]]) {
      expect(buildTree(entries(...order)).find((n) => n.children.length > 0)!.name).toBe("Plan.markdown");
    }
  });

  async function menu(path: string, lm?: boolean, paths = ["Note.md", "Plan.hmdoc", "Section"]) {
    const notebook = lm ? { id: "lm:demo:plans", path: "demo", title: "Plans", added: "" } : { id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["notebook-tree", notebook.id], { entries: entries(...paths), truncated: false });
    const lmInfo = lm ? { domain: "demo", notebook: "plans", title: "Plans", visibility: "searchable", private: false, revision: "r", pages: 1, assets: 0, asset_bytes: 0, proposals: 0, updated: "" } : undefined;
    const el = await mount(<NotebookTree notebook={notebook} lm={lmInfo as never} onSettings={() => {}} onProposals={() => {}} />, client);
    await settle();
    await act(async () => { el.querySelector(`[data-tree-path="${path}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return { el, labels: [...document.querySelectorAll(".menu-list.context [role='menuitem']")].map((b) => b.textContent) };
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("a Markdown page offers Convert to rich page and a rich subpage; a rich page offers Export to Markdown", async () => {
    const md = await menu("Note.md");
    expect(md.labels).toContain("Convert to rich page");
    expect(md.labels).toContain("New rich subpage");
    expect(md.labels).not.toContain("Export to Markdown…");
    await act(async () => root?.unmount());
    const rich = await menu("Plan.hmdoc");
    expect(rich.labels).toContain("Export to Markdown…");
    expect(rich.labels).toContain("New rich subpage");
    expect(rich.labels).not.toContain("Convert to rich page");
    await act(async () => root?.unmount());
    const section = await menu("Section");
    expect(section.labels).toContain("New rich page here");
  });

  it("R1-15: a rich page beside a Markdown page of the same name has no subpage commands, and the folder is the Markdown page's", async () => {
    const paths = ["Plan.hmdoc", "Plan.md", "Plan", "Plan/Sub.md"];
    for (const list of [paths, [...paths].reverse()]) {
      const tree = buildTree(entries(...list));
      expect(tree.map((n) => n.name)).toEqual(["Plan.hmdoc", "Plan.md"]);
      expect(tree.find((n) => n.name === "Plan.md")!.children.map((n) => n.path)).toEqual(["Plan/Sub.md"]);
      expect(tree.find((n) => n.name === "Plan.hmdoc")!.children).toEqual([]);
    }
    const rich = await menu("Plan.hmdoc", false, paths);
    expect(rich.labels).toContain("Export to Markdown…");
    expect(rich.labels.some((l) => /subpage/i.test(l ?? ""))).toBe(false);
    await act(async () => root?.unmount());
    const md = await menu("Plan.md", false, paths);
    expect(md.labels).toContain("New subpage");
    expect(md.labels).toContain("New rich subpage");
  });

  it("a Living Memory notebook offers none of them", async () => {
    const md = await menu("Note.md", true);
    expect(md.labels.length).toBeGreaterThan(0);
    expect(md.labels.some((l) => /rich|Export to Markdown/i.test(l ?? ""))).toBe(false);
    await act(async () => root?.unmount());
    const section = await menu("Section", true);
    expect(section.labels.some((l) => /rich/i.test(l ?? ""))).toBe(false);
  });

  it("the notebook's actions menu has New rich page for a folder notebook", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["notebook-tree", "nb-1"], { entries: entries("Note.md"), truncated: false });
    const el = await mount(<NotebookTree notebook={{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }} onSettings={() => {}} />, client);
    await settle();
    await click(el.querySelector('[aria-label="Notebook actions"]'));
    expect(item("New rich page")).toBeTruthy();
    await click(item("New rich page"));
    await until(() => files.has("Untitled.hmdoc"), "the new page");
  });
});
