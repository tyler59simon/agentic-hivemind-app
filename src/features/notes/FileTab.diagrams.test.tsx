// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const sha = (text: string) => `sha-${text.length}-${text.slice(0, 20)}`;

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../ui/Mermaid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/Mermaid")>();
  return { ...actual, renderMermaid: vi.fn(async () => ({ ok: true as const, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' })) };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [...files.keys()].map((p) => ({ path: p, kind: "text" })), truncated: false };
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: files.get(path)!.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_delete": drafts.delete(a.key as string); return null;
      default: return null;
    }
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("./FileTab");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { NEW_SVG_TEXT } = await import("../svg/svg");

let root: Root | null = null;
let stop = () => {};

async function mount(node: ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>); });
  return el;
}

async function until(what: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (what()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error("timed out");
}

const tabs = (el: ParentNode) => [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent);

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

describe("FileTab for .svg and .mmd files", () => {
  it("opens .svg in Preview mode with isolated <img> rendering and Preview/Split/Source/History tabs", async () => {
    const withScript = NEW_SVG_TEXT.replace("</svg>", "<script>window.__xss = true;</script></svg>");
    files.set("icon.svg", withScript);
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "icon.svg" }, mode: "preview" });
    const el = await mount(<FileTab tab={useWorkspace.getState().panes[0].tabs[0]} />);
    await until(() => el.querySelector("img.svg-preview-img"));
    expect(tabs(el)).toEqual(["Preview", "Split", "Source", "History"]);
    expect(el.querySelector("img.svg-preview-img")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(el.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
  });

  it("opens .mmd in Split mode with Split/Preview/Source/History tabs", async () => {
    files.set("arch.mmd", "flowchart TD\n  A --> B\n");
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "arch.mmd" }, mode: "split" });
    const el = await mount(<FileTab tab={useWorkspace.getState().panes[0].tabs[0]} />);
    await until(() => el.querySelector(".mermaid-diagram svg") && el.querySelector(".cm-content"));
    expect(tabs(el)).toEqual(["Split", "Preview", "Source", "History"]);
    expect(document.querySelector("iframe")).toBeNull();
  });
});
