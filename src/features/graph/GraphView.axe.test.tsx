// @vitest-environment jsdom
// Text alternatives for the graph (DESK-A11Y A3): the drawing is an image with a summary for a name, and "Show as list" swaps it
// for a list of the shown nodes that opens them like a click on the drawing does. sigma needs WebGL, so it is mocked as in the
// other tests; the real GraphCanvas draws its host element, which is what carries the name.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";
import type { UnifiedGraph, UnifiedNode } from "./graphData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

const { open, store } = vi.hoisted(() => ({ open: vi.fn(), store: { graph: { nodes: [], edges: [] } as UnifiedGraph } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "notebooks_list" || cmd === "index_tags" ? [] : null)) }));
vi.mock("sigma", () => ({ default: class { on() {} refresh() {} resize() {} kill() {} } }));
vi.mock("./useUnifiedGraph", () => ({
  useUnifiedGraph: () => ({ graph: store.graph, linksSupported: true, notebooks: [], isLoading: false, memoryError: null, pagesError: null }),
  openGraphNode: (node: UnifiedNode, split: boolean) => open(node, split),
}));

const { GraphView } = await import("./GraphView");
const { LocalGraphPanel } = await import("../links/LinksPanel");

const note = (ref: string, title: string): UnifiedNode => ({ id: ref, kind: "note", ref, domain: "d", title, noteType: "knowledge", status: "active", tags: [] });
const page: UnifiedNode = { id: "page\0nb\0P.md", kind: "page", file: { notebook: "nb", path: "P.md" }, notebookTitle: "Notebook", pageKind: "md", title: "Roadmap", tags: [] };

let root: Root | null = null;
let el: HTMLElement;
beforeEach(() => {
  open.mockClear();
  store.graph = {
    nodes: [note("d:b", "Zebra"), note("d:a", "Alpha"), page],
    edges: [{ from: "d:a", to: "d:b", kind: "link" }, { from: "page\0nb\0P.md", to: "d:a", kind: "link" }],
  };
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const show = async (ui: React.ReactNode) => { await act(async () => root!.render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>)); };
const button = (name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(name))!;
const click = (b: Element, init: MouseEventInit = {}) => act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })); });

describe("the graph view", () => {
  it("names the drawing with a summary that follows the filter", async () => {
    await show(<GraphView />);
    const host = el.querySelector(".graph-host")!;
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("Graph of 2 notes, 1 page and 2 links");
    await click(button("Pages"));
    expect(el.querySelector(".graph-host")!.getAttribute("aria-label")).toBe("Graph of 2 notes and 1 link");
  });

  it("shows the nodes as a list, by title, with link counts and neighbours, in place of the drawing", async () => {
    await show(<GraphView />);
    const toggle = button("Show as list");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector(".graph-host")).toBeNull();
    const rows = [...el.querySelectorAll(".graph-list > li")];
    expect(rows.map((r) => r.querySelector(":scope > button")!.textContent)).toEqual(["Alpha", "Roadmap", "Zebra"]);
    expect(rows[0].textContent).toContain("knowledge · 2 links");
    expect(rows[1].textContent).toContain("page · 1 link");
    expect([...rows[0].querySelectorAll(":scope > ul button")].map((b) => b.textContent)).toEqual(["Roadmap", "Zebra"]);
    await click(toggle);
    expect(el.querySelector(".graph-host")).not.toBeNull();
    expect(el.querySelector(".graph-list")).toBeNull();
  });

  it("opens a node from the list as a click on the drawing does, in a split with Ctrl", async () => {
    await show(<GraphView />);
    await click(button("Show as list"));
    const alpha = el.querySelector(".graph-list > li > button")!;
    await click(alpha);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: "d:a" }), false);
    await click(el.querySelector(".graph-list ul button")!, { ctrlKey: true });
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: "page\0nb\0P.md" }), true);
  });

  it("has no axe violations as a drawing or as a list", async () => {
    await show(<GraphView />);
    await expectNoNewAxeViolations(el, []);
    await click(button("Show as list"));
    await expectNoNewAxeViolations(el, []);
  });
});

describe("the local graph in the rail", () => {
  it("names its drawing, and has no axe violations", async () => {
    await show(<LocalGraphPanel focusRef="d:a" />);
    expect(el.querySelector(".graph-host")!.getAttribute("aria-label")).toBe("Local graph of 2 notes, 1 page and 2 links");
    await expectNoNewAxeViolations(el, []);
  });
});
