// @vitest-environment jsdom
// DESK-6: the tab strip works from the keyboard. One tab is in the Tab order; arrows move the focus along the strip without
// opening a tab, Enter opens the focused one, Delete closes it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const page = (id: string, path: string) => ({ id, kind: "file" as const, file: { notebook: "nb", path }, mode: "live" as const });
const tabs = () => [...document.querySelectorAll<HTMLElement>("[role=tab]")];
const press = async (key: string) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};

describe("the tab strip from the keyboard", () => {
  it("moves the focus with arrows, opens with Enter and closes with Delete", async () => {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [page("a", "A.md"), page("b", "B.md"), page("c", "C.md")], active: "a" }], focused: "p0", dirty: {}, reveal: null });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(document.querySelector("[role=tablist]")!.getAttribute("aria-label")).toBe("Open notes and pages");
    expect(document.querySelector("[role=tabpanel]")).not.toBeNull();
    tabs()[0].focus();
    await press("ArrowRight");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(useWorkspace.getState().panes[0].active).toBe("a");
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tabs()[2]);
    await press("Home");
    expect(document.activeElement).toBe(tabs()[0]);
    await press("End");
    await press("Enter");
    expect(useWorkspace.getState().panes[0].active).toBe("c");
    await press("Delete");
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.id)).toEqual(["a", "b"]);
    // The focus goes to the tab now at the end, so the arrows keep working (Codex review, DESK-R6).
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement).toBe(tabs()[1]);
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("makes the pane the keyboard enters the current one, without opening another tab (Codex review, DESK-R7)", async () => {
    useWorkspace.setState({
      panes: [{ id: "p0", tabs: [page("a", "A.md")], active: "a" }, { id: "p1", tabs: [page("b", "B.md"), page("c", "C.md")], active: "b" }],
      focused: "p0", dirty: {}, reveal: null,
    });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
    const second = tabs().find((t) => t.textContent?.includes("B"))!;
    await act(async () => second.focus());
    expect(useWorkspace.getState().focused).toBe("p1");
    await press("ArrowRight");
    expect(useWorkspace.getState().panes[1].active).toBe("b");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, cancelable: true })); });
    expect(useWorkspace.getState().panes.map((p) => p.tabs.map((t) => t.id))).toEqual([["a"], ["c"]]);
  });
});

describe("the tab strip's markup", () => {
  async function mount(dirty: Record<string, boolean>) {
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [page("a", "A.md"), page("b", "B.md")], active: "a" }], focused: "p0", dirty, reveal: null });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
  }

  it("keeps only tabs in the tab list, with the buttons beside it and the close mark outside the tab", async () => {
    await mount({});
    const list = document.querySelector("[role=tablist]")!;
    expect(list.querySelectorAll("button, a, input, [tabindex='0']").length).toBe(1); // the active tab
    expect([...list.querySelectorAll("[role=tab]")].every((t) => !t.querySelector("button, .tab-close"))).toBe(true);
    // The buttons that were in the strip are still in it, after the tab list.
    const strip = list.parentElement!;
    expect([...strip.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["New note", "Split", "Context rail"]);
    expect(list.contains(strip.querySelector("button"))).toBe(false);
    // The close mark is for the mouse: hidden from assistive technology, not a Tab stop, and it closes the tab.
    const mark = document.querySelector<HTMLElement>(".note-tab-pill .tab-close")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.closest("[role=tab]")).toBeNull();
    await act(async () => mark.click());
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.id)).toEqual(["b"]);
  });

  it("names a tab by the page, and says so in words when it has unsaved edits", async () => {
    await mount({ a: true });
    const [a, b] = tabs();
    expect(a.textContent).toBe("A●, unsaved");
    expect(b.textContent).toBe("B");
    expect(a.querySelector(".dot")!.getAttribute("aria-hidden")).toBe("true");
    expect(a.querySelector(".visually-hidden")!.textContent).toBe(", unsaved");
    expect(a.closest(".note-tab-pill")!.getAttribute("title")).toBe("A");
  });

  it("names the pane and its tab panel", async () => {
    await mount({});
    expect(document.querySelector("section.pane")!.getAttribute("aria-label")).toBe("Open notes");
    expect(document.querySelector("[role=tabpanel]")!.getAttribute("aria-label")).toBe("A");
    expect(document.querySelector<HTMLElement>("[role=tabpanel]")!.tabIndex).toBe(-1);
  });
});
