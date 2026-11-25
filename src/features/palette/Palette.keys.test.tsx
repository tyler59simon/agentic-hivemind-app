// @vitest-environment jsdom
// DESK-KEYS: the palette shows each command's keys from the registry, so a remap in Settings and macOS show in it, and its
// "Keyboard shortcuts" entry opens the reference sheet.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sigma", () => ({ default: class {} }));
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
const { useShortcutsDialog } = await import("../shortcuts/ShortcutsDialog");
const { setOverrides } = await import("../../lib/shortcuts");
const { setMacForTests } = await import("../../lib/platform");

let root: Root | null = null;
const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".palette li button")].find((b) => b.querySelector("span")!.textContent === label);
const detail = (label: string) => row(label)?.querySelectorAll("span")[1]?.textContent;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await act(async () => useApp.getState().setPalette("commands"));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  setMacForTests(false);
  useShortcutsDialog.getState().hide();
  useApp.getState().setPalette(null);
  document.body.innerHTML = "";
});

describe("the palette's keys", () => {
  it("are the default combos", () => {
    expect(detail("Go to note…")).toBe("Ctrl+O");
    expect(detail("New note")).toBe("Ctrl+N");
    expect(detail("Open the graph")).toBe("Ctrl+G");
    expect(detail("Zoom in")).toBe("Ctrl+=");
    expect(detail("Zoom out")).toBe("Ctrl+-");
    expect(detail("Reset zoom")).toBe("Ctrl+0");
    expect(detail("Search notes and pages")).toBe("Ctrl+K");
    expect(detail("Back")).toBe("Alt+Left");
    expect(detail("Open the note side by side")).toBe("Ctrl+\\");
    expect(detail("New page")).toBe("Ctrl+N on Notes");
    expect(detail("Keyboard shortcuts")).toBe("Ctrl+/");
  });

  it("follow a remap while the palette is open", async () => {
    await act(async () => setOverrides({ "note.new": "Mod+Shift+J", "zoom.in": "Alt+Z", "shortcuts.show": "Mod+Alt+K" }));
    expect(detail("New note")).toBe("Ctrl+Shift+J");
    expect(detail("New page")).toBe("Ctrl+Shift+J on Notes");
    expect(detail("Zoom in")).toBe("Alt+Z");
    expect(detail("Keyboard shortcuts")).toBe("Ctrl+Alt+K");
    await act(async () => setOverrides({}));
    expect(detail("New note")).toBe("Ctrl+N");
  });

  it("are spelled for macOS", async () => {
    setMacForTests(true);
    await act(async () => setOverrides({ "note.new": "Mod+J" })); // any change draws the list again
    expect(detail("Go to note…")).toBe("Cmd+O");
    expect(detail("Back")).toBe("Option+Left");
    expect(detail("New note")).toBe("Cmd+J");
  });

  it("have an entry that opens the reference sheet", async () => {
    await act(async () => row("Keyboard shortcuts")!.click());
    expect(useShortcutsDialog.getState().open).toBe(true);
    expect(useApp.getState().palette).toBeNull();
  });
});
