// @vitest-environment jsdom
// The graph under a contrast theme and with reduced motion (DESK-A11Y A4): sigma gets system colours and no camera animation.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedGraph, UnifiedNode } from "./graphData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { settings: Record<string, unknown>; nodeReducer: (n: string, d: Record<string, unknown>) => Record<string, unknown>; edgeReducer: (e: string, d: Record<string, unknown>) => Record<string, unknown> };
const made: { opts: Opts; killed: boolean; graph: { edges(): string[] } }[] = [];
vi.mock("sigma", () => ({
  default: class {
    rec: { opts: Opts; killed: boolean; graph: { edges(): string[] } };
    constructor(graph: { edges(): string[] }, _el: unknown, opts: Opts) { this.rec = { opts, killed: false, graph }; made.push(this.rec); }
    on() {} refresh() {} resize() {}
    kill() { this.rec.killed = true; }
  },
}));
vi.mock("../preview/HoverPreview", () => ({ PreviewCard: () => null, PagePreviewCard: () => null }));
vi.mock("../../lib/forcedColors", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/forcedColors")>();
  const rgb: Record<string, string> = { Canvas: "rgb(0, 0, 0)", CanvasText: "rgb(255, 255, 255)", Highlight: "rgb(26, 235, 255)", HighlightText: "rgb(0, 0, 0)", GrayText: "rgb(63, 242, 63)" };
  return { ...real, systemColor: (k: string) => rgb[k], systemPalette: () => real.systemPalette((k) => rgb[k]) };
});
class ResizeObserverStub { observe() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const { GraphCanvas } = await import("./GraphCanvas");

const note = (id: string): UnifiedNode => ({ id, kind: "note", ref: id, domain: "d", title: id, noteType: "knowledge", status: "active", tags: [] });
const data: UnifiedGraph = { nodes: [note("a"), note("b")], edges: [{ from: "a", to: "b", kind: "link" }] };

const last = () => made[made.length - 1];
let reduced = false;
let forced = false;
const listeners = new Set<() => void>();
let root: Root | null = null;

beforeEach(() => {
  made.length = 0;
  reduced = false; forced = false; listeners.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() { return q.includes("reduced-motion") ? reduced : q.includes("forced-colors") ? forced : false; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<GraphCanvas data={data} focus="a" onOpen={() => {}} />));
}

describe("GraphCanvas", () => {
  it("keeps the theme's colours and sigma's camera animations by default", async () => {
    await mount();
    const { opts } = last()!;
    expect(opts.settings).not.toHaveProperty("zoomDuration");
    expect(opts.nodeReducer("b", { color: "#abc" })).not.toHaveProperty("color");
  });

  it("draws in the system colours under a contrast theme, the focused node in Highlight, and draws again when the theme changes", async () => {
    forced = true;
    await mount();
    const { opts } = last()!;
    expect(opts.nodeReducer("b", {})).toMatchObject({ color: "rgb(255, 255, 255)", labelColor: "rgb(255, 255, 255)" });
    expect(opts.nodeReducer("a", {})).toMatchObject({ color: "rgb(26, 235, 255)", highlighted: true });
    expect(opts.edgeReducer(last()!.graph.edges()[0], { size: 1 }).color).toBe("rgb(63, 242, 63)");
    const before = made.length;
    forced = false;
    await act(async () => listeners.forEach((fn) => fn()));
    expect(made.length).toBeGreaterThan(before);
    expect(made[before - 1].killed).toBe(true);
    expect(last()!.opts.nodeReducer("b", {})).not.toHaveProperty("color");
  });

  it("ends the camera animations when the user asked for less motion", async () => {
    reduced = true;
    await mount();
    expect(last()!.opts.settings).toMatchObject({ inertiaDuration: 0, zoomDuration: 0, doubleClickZoomingDuration: 0 });
  });
});
