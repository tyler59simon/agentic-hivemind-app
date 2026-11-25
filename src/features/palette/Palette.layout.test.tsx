// @vitest-environment jsdom
// DESK-LAYOUT: the palette has a command for the sidebar, focus mode and full screen, with their keys.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = { isFullscreen: vi.fn(async () => false), setFullscreen: vi.fn(async () => {}) };
vi.mock("sigma", () => ({ default: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("../../lib/native", () => ({ inTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    switch (cmd) {
      case "notebooks_list": return [];
      case "lm": return { exit_code: 0, error: null, result: { domains: [], notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Palette } = await import("./Palette");
const { useApp } = await import("../../store");
const { useLayout } = await import("../../shell/layout");
const { useWorkspace } = await import("../../workspace/store");
const { useNotesSearch } = await import("../search/store");

let root: Root | null = null;
const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".palette li button")].find((b) => b.querySelector("span")!.textContent === label);
const detail = (label: string) => row(label)?.querySelectorAll("span")[1]?.textContent;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
/** A wide window, where the rail sits beside the note and its switch is `rail`; jsdom is 1024 px, where it lies over the note. */
const wide = (px: number) => act(() => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); window.dispatchEvent(new Event("resize")); });
const reset = () => {
  useLayout.setState({ sidebarCollapsed: false, focusMode: false });
  // The Notes page with a note open: the only place the rail draws.
  useApp.setState({ route: { page: "notes" } });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t" }], rail: true, railSplit: false, railNarrow: false });
};

beforeEach(async () => {
  reset();
  win.isFullscreen.mockClear(); win.setFullscreen.mockClear();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await act(async () => useApp.getState().setPalette("commands"));
  await settle();
});
afterEach(async () => {
  await wide(1024);
  await act(async () => root?.unmount());
  root = null;
  useApp.getState().setPalette(null);
  reset();
  document.body.innerHTML = "";
});

describe("the layout commands", () => {
  it("show their keys", () => {
    expect(detail("Collapse the sidebar")).toBe("Ctrl+Shift+B");
    expect(detail("Focus mode")).toBe("Ctrl+Shift+M");
    expect(detail("Full screen")).toBe("F11");
  });

  it("collapse and expand the sidebar, and say which they will do", async () => {
    await act(async () => row("Collapse the sidebar")!.click());
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    expect(useApp.getState().palette).toBeNull();
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    expect(row("Expand the sidebar")).toBeDefined();
    expect(row("Collapse the sidebar")).toBeUndefined();
  });

  it("enter and leave focus mode", async () => {
    await act(async () => row("Focus mode")!.click());
    expect(useLayout.getState().focusMode).toBe(true);
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    await act(async () => row("Exit focus mode")!.click());
    expect(useLayout.getState().focusMode).toBe(false);
  });

  it("turn full screen on", async () => {
    await act(async () => row("Full screen")!.click());
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  // R1: the search box is hidden in focus mode, so every command that searches leaves it first.
  it("search commands leave focus mode, then ask the box to focus", async () => {
    for (const label of ["Search notes and pages", "Search active notes", "Search the archive"]) {
      useLayout.setState({ focusMode: true });
      const tick = useNotesSearch.getState().focusTick;
      await act(async () => useApp.getState().setPalette("commands"));
      await settle();
      await act(async () => row(label)!.click());
      expect(useLayout.getState().focusMode, label).toBe(false);
      expect(useNotesSearch.getState().focusTick, label).toBeGreaterThan(tick);
    }
  });

  // R4: the rail is hidden in focus mode, so its command shows it and leaves the mode.
  it("the rail command leaves focus mode and shows the rail, instead of changing what is hidden", async () => {
    await wide(1500);
    useWorkspace.setState({ rail: false });
    useLayout.setState({ focusMode: true });
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    expect(row("Show the note's context rail")).toBeDefined();
    await act(async () => row("Show the note's context rail")!.click());
    expect(useLayout.getState().focusMode).toBe(false);
    expect(useWorkspace.getState().rail).toBe(true);
  });

  // F8: the rail draws only beside an open note on the Notes page; elsewhere there is nothing to show.
  it("offers the rail command only on the Notes page with a document open", async () => {
    const offered = async () => {
      await act(async () => useApp.getState().setPalette("commands"));
      await settle();
      const found = !!(row("Hide the note's context rail") ?? row("Show the note's context rail"));
      await act(async () => useApp.getState().setPalette(null));
      return found;
    };
    await wide(1500);
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "t", kind: "note", ref: "d:1" }], active: "t" }] });
    useApp.setState({ route: { page: "agents" } });
    expect(await offered()).toBe(false);
    useApp.setState({ route: { page: "notes", view: "tasks" } });
    expect(await offered()).toBe(false);
    useApp.setState({ route: { page: "notes" } });
    expect(await offered()).toBe(true);
    useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }] });
    expect(await offered()).toBe(false);
  });

  it("the rail command says Show in focus mode even when the rail is on, and hides it outside focus mode", async () => {
    await wide(1500);
    useWorkspace.setState({ rail: true });
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    expect(row("Hide the note's context rail")).toBeDefined();
    await act(async () => row("Hide the note's context rail")!.click());
    expect(useWorkspace.getState().rail).toBe(false);
    useWorkspace.setState({ rail: true });
    useLayout.setState({ focusMode: true });
    await act(async () => useApp.getState().setPalette("commands"));
    await settle();
    expect(row("Show the note's context rail")).toBeDefined();
  });
});
