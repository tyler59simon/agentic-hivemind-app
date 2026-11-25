// @vitest-environment jsdom
// The layout keys (DESK-LAYOUT): F11 toggles full screen through the window API, Ctrl+Shift+B the sidebar and Ctrl+Shift+M
// focus mode; a dialog in front stops them and a remap moves them.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = { onCloseRequested: async () => () => {}, destroy: async () => {}, isFullscreen: vi.fn(async () => false), setFullscreen: vi.fn(async () => {}) };
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("./lib/native", () => ({ inTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { useShortcuts } = await import("./App");
const { useLayout } = await import("./shell/layout");
const { setOverrides } = await import("./lib/shortcuts");
const { pushLayer } = await import("./ui/layers");

function Host() { useShortcuts(); return null; }

let root: Root | null = null;
const press = async (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  await act(async () => { window.dispatchEvent(e); });
  return e;
};
const reset = () => useLayout.setState({ sidebarCollapsed: false, focusMode: false });

beforeEach(async () => {
  reset();
  win.isFullscreen.mockReset(); win.isFullscreen.mockResolvedValue(false);
  win.setFullscreen.mockReset();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  reset();
  document.body.innerHTML = "";
});

describe("F11", () => {
  it("turns full screen on, and off when the window is in it", async () => {
    expect((await press("F11")).defaultPrevented).toBe(true);
    expect(win.setFullscreen).toHaveBeenLastCalledWith(true);
    win.isFullscreen.mockResolvedValue(true);
    await press("F11");
    expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("is not F11 with a modifier, nor held down", async () => {
    await press("F11", { ctrlKey: true });
    await press("F11", { shiftKey: true });
    await press("F11", { repeat: true });
    expect(win.setFullscreen).not.toHaveBeenCalled();
  });

  it("waits while a dialog is open", async () => {
    const dialog = pushLayer(() => {}, () => false, true);
    await press("F11");
    expect(win.setFullscreen).not.toHaveBeenCalled();
    dialog.pop();
  });

  it("follows a remap", async () => {
    setOverrides({ "fullscreen.toggle": "Mod+Shift+U" });
    await press("F11");
    expect(win.setFullscreen).not.toHaveBeenCalled();
    await press("U", { ctrlKey: true, shiftKey: true });
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe("the sidebar and focus mode keys", () => {
  it("Ctrl+Shift+B collapses and expands the sidebar", async () => {
    expect((await press("B", { ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(true);
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    await press("B", { ctrlKey: true, shiftKey: true });
    expect(useLayout.getState().sidebarCollapsed).toBe(false);
  });

  it("Ctrl+B stays the editor's bold", async () => {
    await press("b", { ctrlKey: true });
    expect(useLayout.getState().sidebarCollapsed).toBe(false);
  });

  it("Ctrl+Shift+M enters and leaves focus mode", async () => {
    await press("M", { ctrlKey: true, shiftKey: true });
    expect(useLayout.getState().focusMode).toBe(true);
    await press("M", { ctrlKey: true, shiftKey: true });
    expect(useLayout.getState().focusMode).toBe(false);
  });

  it("wait while a dialog is open", async () => {
    const dialog = pushLayer(() => {}, () => false, true);
    await press("B", { ctrlKey: true, shiftKey: true });
    await press("M", { ctrlKey: true, shiftKey: true });
    expect(useLayout.getState()).toMatchObject({ sidebarCollapsed: false, focusMode: false });
    dialog.pop();
  });
});
