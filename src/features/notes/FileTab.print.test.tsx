// @vitest-environment jsdom
// DOCOS-1A: Export to PDF from a Markdown page's menu or the palette's print intent. The page is drawn for print in
// `.print-root` by PrintHost, Rust is asked to save it, and the copy is gone afterwards. Only Markdown pages offer it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
// jsdom loads no pictures, so one would never count as drawn.
Object.defineProperty(HTMLImageElement.prototype, "complete", { get: () => true, configurable: true });

const files = new Map<string, string>();
type Saved = { notebook: string; path: string };
const exports = vi.hoisted(() => ({ asked: [] as string[], answer: null as Saved | null | Error, printRoot: [] as number[], pictures: [] as (string | null)[][], hold: null as Promise<void> | null }));
const grants = vi.hoisted(() => ({ wait: null as Promise<void> | null }));
const toasts = vi.hoisted(() => [] as { text: string; kind?: string }[]);
vi.mock("../../ui/toast", () => ({ toast: (text: string, kind?: string) => { toasts.push({ text, kind }); }, Toasts: () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: "page" })), truncated: false };
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: `sha-${path}`, size: files.get(path)!.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "asset_base": await grants.wait; return "http://hmfile.localhost/g1/";
      case "page_export_pdf":
        exports.asked.push(a.suggested as string);
        // How many pages the webview shows for print while Rust prints it.
        exports.printRoot.push(document.querySelectorAll(".print-root .page-view").length);
        exports.pictures.push([...document.querySelectorAll(".print-root img")].map((img) => img.getAttribute("src")));
        await exports.hold;
        if (exports.answer instanceof Error) throw exports.answer;
        return exports.answer;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("./FileTab");
const { PrintHost, usePrintIntent, usePrintJob } = await import("./printPage");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");

const ws = () => useWorkspace.getState();
let root: Root | null = null;
let host: Root | null = null;
let stop = () => {};

async function until(what: () => unknown, label: string) {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}
const item = (text: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.trim() === text) ?? null;
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

const client = { current: new QueryClient() };

/** Open `path` in a tab beside the app's print host, which lives in its own root so the tab can go while it exports. */
async function open(path: string, node?: (tab: ReturnType<typeof ws>["panes"][0]["tabs"][0]) => ReactNode) {
  ws().openTab({ kind: "file", file: { notebook: "nb-1", path }, mode: "source" });
  const tabs = ws().panes[0].tabs;
  const tab = tabs[tabs.length - 1];
  const el = document.createElement("div");
  const hostEl = document.createElement("div");
  document.body.append(el, hostEl);
  root = createRoot(el);
  host = createRoot(hostEl);
  await act(async () => { host!.render(<QueryClientProvider client={client.current}><PrintHost /></QueryClientProvider>); });
  await act(async () => { root!.render(<QueryClientProvider client={client.current}>{node ? node(tab) : <FileTab tab={tab} />}</QueryClientProvider>); });
  await until(() => el.querySelector(".cm-content"), path);
  return { el, tab };
}

describe("Export to PDF", () => {
  beforeEach(() => {
    files.clear();
    exports.asked.length = 0; exports.printRoot.length = 0; exports.pictures.length = 0; exports.answer = { notebook: "nb-1", path: "Plan.pdf" }; exports.hold = null;
    grants.wait = null;
    client.current = new QueryClient();
    usePrintJob.setState({ job: null });
    toasts.length = 0;
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
    useApp.setState({ route: { page: "notes" }, back: [] });
    docs.useDocuments.setState({ docs: {}, refs: {} });
    usePrintIntent.setState({ tabId: null });
    stop = startDocumentSync();
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    await act(async () => host?.unmount());
    root = null; host = null;
    document.body.innerHTML = "";
    stop();
  });

  it("the page's menu draws the page for print, asks Rust to save it as <name>.pdf, says where, and removes the copy", async () => {
    files.set("Plan.md", "# Plan\n\nSome *text*.\n");
    await open("Plan.md");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => toasts.length, "the toast");
    expect(exports.asked).toEqual(["Plan.pdf"]);
    expect(exports.printRoot).toEqual([1]);
    expect(toasts).toEqual([{ text: "Saved Plan.pdf", kind: undefined }]);
    // The copy drawn for print is in light colours and is gone once the export ends.
    expect(document.querySelector(".print-root")).toBeNull();
  });

  it("a cancelled save dialog says nothing, and a refusal shows as an error", async () => {
    files.set("Plan.md", "# Plan\n");
    await open("Plan.md");
    exports.answer = null;
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => exports.asked.length === 1 && !document.querySelector(".print-root"), "the cancelled export");
    expect(toasts).toEqual([]);
    exports.answer = new Error("This is inside a .git folder, which Hivemind does not edit");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => toasts.length, "the error");
    expect(toasts).toEqual([{ text: "This is inside a .git folder, which Hivemind does not edit", kind: "error" }]);
  });

  it("the palette's print intent exports the tab it names", async () => {
    files.set("Notes/Daily.markdown", "Today\n");
    exports.answer = { notebook: "nb-1", path: "Notes/Daily.pdf" };
    const { tab } = await open("Notes/Daily.markdown");
    await act(async () => { usePrintIntent.getState().request(tab.id); });
    await until(() => toasts.length, "the toast");
    expect(exports.asked).toEqual(["Daily.pdf"]);
    expect(toasts).toEqual([{ text: "Saved Daily.pdf", kind: undefined }]);
    expect(usePrintIntent.getState().tabId).toBeNull();
  });

  it("runs one export at a time: a second request while the first prints is told to wait (Codex review of f38e4c3, P1)", async () => {
    files.set("Plan.md", "# Plan\n");
    let release = () => {};
    exports.hold = new Promise((r) => { release = r; });
    const { tab } = await open("Plan.md");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => exports.asked.length === 1, "the first export");
    await act(async () => { usePrintIntent.getState().request(tab.id); });
    await until(() => toasts.length, "the warning");
    expect(toasts).toEqual([{ text: "Another page is still being exported to PDF", kind: "warn" }]);
    expect(exports.printRoot).toEqual([1]);
    await act(async () => { release(); });
    await until(() => !document.querySelector(".print-root"), "the end of the export");
    expect(exports.asked).toEqual(["Plan.pdf"]);
  });

  it("keeps exporting when the page's tab goes away while the save dialog is open (Codex review of f38e4c3, P2)", async () => {
    files.set("Plan.md", "# Plan\n\nBody\n");
    let release = () => {};
    exports.hold = new Promise((r) => { release = r; });
    await open("Plan.md");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => exports.asked.length === 1, "the export");
    await act(async () => root?.unmount());
    root = null;
    expect(document.querySelector(".print-root .page-view")?.textContent).toContain("Body");
    await act(async () => { release(); });
    await until(() => toasts.length, "the toast");
    expect(toasts).toEqual([{ text: "Saved Plan.pdf", kind: undefined }]);
  });

  it("waits for the page's picture prefix before drawing it for print (Codex review of f38e4c3, P2)", async () => {
    files.set("Plan.md", "# Plan\n\n![a](a.png)\n");
    let grant = () => {};
    grants.wait = new Promise((r) => { grant = r; });
    await open("Plan.md");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(exports.asked).toEqual([]);
    await act(async () => { grant(); });
    await until(() => exports.asked.length === 1, "the export");
    // Drawn as a picture, not the placeholder a page shows before its prefix is known.
    expect(exports.pictures).toEqual([["http://hmfile.localhost/g1/a.png"]]);
  });

  it("shows a PDF saved into the notebook in its tree (Codex review of f38e4c3, P3)", async () => {
    files.set("Plan.md", "# Plan\n");
    await open("Plan.md");
    const invalidate = vi.spyOn(client.current, "invalidateQueries");
    await click(document.querySelector('[aria-label="Page actions"]'));
    await click(item("Export to PDF…"));
    await until(() => toasts.length, "the toast");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notebook-tree", "nb-1"] });
  });

  it("is offered only for Markdown pages", async () => {
    files.set("notes.txt", "plain\n");
    await open("notes.txt");
    await click(document.querySelector('[aria-label="Page actions"]'));
    expect(item("Copy path")).not.toBeNull();
    expect(item("Export to PDF…")).toBeNull();
  });
});
