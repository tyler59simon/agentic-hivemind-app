// @vitest-environment jsdom
// The rail button in focus mode (DESK-LAYOUT, review R4): the rail is hidden then, so the button shows it and leaves the mode
// instead of changing a preference nobody can see.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");
const { useLayout } = await import("../shell/layout");

let root: Root | null = null;
const button = () => document.querySelector<HTMLButtonElement>("button[aria-label='Context rail']")!;
const resizeTo = (px: number) => act(() => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); window.dispatchEvent(new Event("resize")); });

beforeEach(async () => {
  await resizeTo(1500);
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null, size: 1 }], focused: "p0", rail: true, railSplit: false, railNarrow: false, dirty: {} });
  useLayout.setState({ focusMode: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  useLayout.setState({ focusMode: false });
  await resizeTo(1024);
  document.body.innerHTML = "";
});

describe("the rail button", () => {
  it("hides the rail outside focus mode, and shows it again", () => {
    expect(button().getAttribute("aria-pressed")).toBe("true");
    act(() => button().click());
    expect(useWorkspace.getState().rail).toBe(false);
    expect(button().getAttribute("aria-pressed")).toBe("false");
    act(() => button().click());
    expect(useWorkspace.getState().rail).toBe(true);
  });

  it("in focus mode is not pressed (the rail is hidden), and a press shows the rail and leaves the mode", () => {
    act(() => useLayout.setState({ focusMode: true }));
    expect(button().getAttribute("aria-pressed")).toBe("false");
    act(() => button().click());
    expect(useLayout.getState().focusMode).toBe(false);
    expect(useWorkspace.getState().rail).toBe(true);
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("in focus mode with the rail saved as off, a press turns it on", () => {
    useWorkspace.setState({ rail: false });
    act(() => useLayout.setState({ focusMode: true }));
    act(() => button().click());
    expect(useLayout.getState().focusMode).toBe(false);
    expect(useWorkspace.getState().rail).toBe(true);
  });

  it("uses the narrow switch when the rail lies over the note", async () => {
    await resizeTo(1000);
    useWorkspace.setState({ railNarrow: false });
    act(() => button().click());
    expect(useWorkspace.getState().railNarrow).toBe(true);
    expect(useWorkspace.getState().rail).toBe(true); // the wide one is untouched
  });
});
