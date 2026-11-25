// @vitest-environment jsdom
// The workspace's keys by the registry (DESK-KEYS): Ctrl+Tab and Ctrl+Shift+Tab cycle tabs, Ctrl+\ splits, Ctrl+E switches
// mode, each moves with a remap, and macOS wants Cmd for the letters and Ctrl for Tab.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("../features/notes/FileTab", () => ({ FileTab: () => null, saveFileTab: vi.fn() }));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Workspace } = await import("./Workspace");
const { useWorkspace } = await import("./store");
const { setOverrides } = await import("../lib/shortcuts");
const { setMacForTests } = await import("../lib/platform");

let root: Root | null = null;
const state = () => useWorkspace.getState();
const press = async (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  await act(async () => { window.dispatchEvent(e); });
  return e;
};

beforeEach(async () => {
  useWorkspace.setState({
    panes: [{ id: "p0", tabs: [{ id: "t1", kind: "note", ref: "d:1", mode: "live" } as never, { id: "t2", kind: "note", ref: "d:2", mode: "live" } as never], active: "t1" }],
    focused: "p0", dirty: {}, reveal: null,
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Workspace /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  setMacForTests(false);
  document.body.innerHTML = "";
});

describe("the default keys", () => {
  it("Ctrl+Tab goes to the next tab and Ctrl+Shift+Tab back", async () => {
    expect((await press("Tab", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(state().panes[0].active).toBe("t2");
    await press("Tab", { ctrlKey: true, shiftKey: true });
    expect(state().panes[0].active).toBe("t1");
  });

  it("Ctrl+\\ opens a second pane", async () => {
    await press("\\", { ctrlKey: true });
    expect(state().panes.length).toBe(2);
  });

  it("Ctrl+E switches the mode, Ctrl+Shift+E and Alt+E do not", async () => {
    await press("e", { ctrlKey: true, shiftKey: true });
    await press("e", { ctrlKey: true, altKey: true });
    expect(state().panes[0].tabs[0].mode).toBe("live");
    await press("e", { ctrlKey: true });
    expect(state().panes[0].tabs[0].mode).toBe("reading");
  });

  it("a plain Tab or a lone letter does nothing", async () => {
    await press("Tab");
    await press("\\");
    expect(state().panes[0].active).toBe("t1");
    expect(state().panes.length).toBe(1);
  });
});

describe("a remap and macOS", () => {
  it("a remapped key does the action and the old one does not", async () => {
    setOverrides({ "view.split": "Mod+J", "view.mode": "Alt+M" });
    await press("\\", { ctrlKey: true });
    await press("e", { ctrlKey: true });
    expect(state().panes.length).toBe(1);
    expect(state().panes[0].tabs[0].mode).toBe("live");
    await press("m", { altKey: true });
    expect(state().panes[0].tabs[0].mode).toBe("reading");
    await press("j", { ctrlKey: true });
    expect(state().panes.length).toBe(2);
  });

  it("a fixed key (Ctrl+Tab) cannot be remapped away", async () => {
    setOverrides({ "tab.next": "Mod+J" });
    await press("Tab", { ctrlKey: true });
    expect(state().panes[0].active).toBe("t2");
  });

  it("wants Cmd for the letters and Ctrl for Tab on macOS", async () => {
    setMacForTests(true);
    await press("Tab", { metaKey: true });
    expect(state().panes[0].active).toBe("t1");
    await press("Tab", { ctrlKey: true });
    expect(state().panes[0].active).toBe("t2");
    await press("\\", { ctrlKey: true });
    expect(state().panes.length).toBe(1);
    await press("\\", { metaKey: true });
    expect(state().panes.length).toBe(2);
  });
});
