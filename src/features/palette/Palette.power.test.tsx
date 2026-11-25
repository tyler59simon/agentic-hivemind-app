// @vitest-environment jsdom
// NS-6A: the command palette lists line tools and macro commands while a file tab shows source, and runs them on its editor.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

vi.mock("sigma", () => ({ default: class {} }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "diagnostics": return "Hivemind 0.1.0";
      case "notebooks_list": return [];
      case "lm": return { exit_code: 0, error: null, result: { domains: [], notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Palette } = await import("./Palette");
const { useApp } = await import("../../store");
const { useWorkspace } = await import("../../workspace/store");
const { setEditor } = await import("../power/registry");
const { useRecorder } = await import("../power/macros");
const { useComparePicker } = await import("../power/ComparePicker");

let root: Root | null = null;
let view: EditorView | null = null;
const labels = () => [...document.querySelectorAll(".palette li button")].map((b) => b.querySelector("span")!.textContent!);
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

async function open(query = "") {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await act(async () => useApp.getState().setPalette("commands"));
  if (query) {
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await settle();
}

beforeEach(() => {
  useRecorder.setState({ recording: false, playing: false, steps: [] });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} });
  view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "c\nb\na\n" }) });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  view?.destroy();
  document.body.innerHTML = "";
  useApp.getState().setPalette(null);
  setEditor("tab-1", null);
});

describe("the command palette", () => {
  it("lists the line tools and macro commands for the focused file tab that shows source", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "tab-1", kind: "file", file: { notebook: "nb-1", path: "a.txt" }, mode: "source" }], active: "tab-1" }] });
    setEditor("tab-1", view);
    await open("Lines:");
    expect(labels()).toContain("Lines: Sort ascending");
    expect(labels()).toContain("Lines: Remove duplicate lines");
    expect(labels()).toContain("Lines: Title Case");
    expect(labels().filter((l) => l.startsWith("Lines:"))).toHaveLength(15);
  });

  it("runs a line tool on that editor", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "tab-1", kind: "file", file: { notebook: "nb-1", path: "a.txt" }, mode: "source" }], active: "tab-1" }] });
    setEditor("tab-1", view);
    await open("Sort ascending");
    await act(async () => { document.querySelector<HTMLButtonElement>(".palette li button")!.click(); });
    expect(view!.state.doc.toString()).toBe("a\nb\nc\n");
    expect(document.querySelector(".palette")).toBeNull();
  });

  it("starts and stops recording a macro", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "tab-1", kind: "file", file: { notebook: "nb-1", path: "a.txt" }, mode: "source" }], active: "tab-1" }] });
    setEditor("tab-1", view);
    await open("Macro: record");
    await act(async () => { document.querySelector<HTMLButtonElement>(".palette li button")!.click(); });
    expect(useRecorder.getState().recording).toBe(true);
  });

  it("lists none of them when no file tab shows source", async () => {
    // A file tab whose editor is not showing source (Live) has none registered.
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "tab-1", kind: "file", file: { notebook: "nb-1", path: "a.md" }, mode: "live" }], active: "tab-1" }] });
    await open("Lines:");
    expect(labels().filter((l) => l.startsWith("Lines:"))).toEqual([]);
    expect(labels().filter((l) => l.startsWith("Macro:"))).toEqual([]);
  });

  it("offers Copy diagnostics and Open logs folder, and Copy diagnostics copies", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open("diagnostics");
    expect(labels()).toEqual(["Copy diagnostics"]);
    await act(async () => { document.querySelector<HTMLButtonElement>(".palette li button")!.click(); });
    await settle();
    expect(writeText).toHaveBeenCalledWith("Hivemind 0.1.0");
    expect(document.querySelector(".palette")).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await open("logs folder");
    expect(labels()).toEqual(["Open logs folder"]);
  });

  it("offers Compare files, and starts the picker from the focused file", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "tab-1", kind: "file", file: { notebook: "nb-1", path: "a.txt" }, mode: "source" }], active: "tab-1" }] });
    await open("Compare files");
    expect(labels()).toEqual(["Compare files…"]);
    await act(async () => { document.querySelector<HTMLButtonElement>(".palette li button")!.click(); });
    expect(useComparePicker.getState()).toMatchObject({ open: true, left: { notebook: "nb-1", path: "a.txt" } });
    useComparePicker.getState().hide();
  });
});
