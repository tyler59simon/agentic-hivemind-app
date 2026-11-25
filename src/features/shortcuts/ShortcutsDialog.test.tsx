// @vitest-environment jsdom
// The shortcut reference sheet (DESK-KEYS): groups, a filter, the keys as remapped, and the quick-capture hotkey as the app
// registered it.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hotkey: string | null = "CommandOrControl+Alt+M";
let hotkeyError: string | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "capture_status" ? { shortcut: hotkey, error: hotkeyError, close_to_tray: true } : null)),
}));

const { ShortcutsDialog, useShortcutsDialog, matchesFilter } = await import("./ShortcutsDialog");
const { setOverrides, shortcut } = await import("../../lib/shortcuts");
const { setMacForTests } = await import("../../lib/platform");
const { useApp } = await import("../../store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const rows = () => [...document.querySelectorAll(".shortcut-row")].map((r) => `${r.querySelector("dt")!.textContent} = ${r.querySelector("kbd")!.textContent}`);
const type = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  hotkey = "CommandOrControl+Alt+M";
  hotkeyError = null;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<ShortcutsDialog />));
});
afterEach(async () => {
  await act(async () => useShortcutsDialog.getState().hide());
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  setMacForTests(false);
  document.body.innerHTML = "";
});

describe("the sheet", () => {
  it("is closed until asked, then lists every group and shortcut", async () => {
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    expect([...document.querySelectorAll(".shortcut-group h3")].map((h) => h.textContent)).toEqual(["Navigation", "Notes", "Tabs and panes", "Window", "Editor", "Terminal"]);
    const all = rows();
    expect(all).toContain("Command palette = Ctrl+P");
    expect(all).toContain("Keyboard shortcuts = Ctrl+/");
    expect(all).toContain("Bold in the editor = Ctrl+B");
    expect(all).toContain("Paste in a terminal = Ctrl+V");
    expect(all).toContain("Quick capture window from anywhere = Ctrl+Alt+M");
  });

  it("filters by name, group or keys, and says when nothing matches", async () => {
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    await type("zoom");
    expect(rows()).toEqual(["Zoom in = Ctrl+=", "Zoom out = Ctrl+-", "Reset zoom = Ctrl+0"]);
    expect(document.querySelector('[role="status"]')!.textContent).toBe("3 shortcuts");
    await type("ctrl+shift+f");
    // Each word is a part of the name, group or keys, so the "f" also finds the terminal's Ctrl+Shift+K (focus).
    expect(rows()).toContain("Search notes and pages (second key) = Ctrl+Shift+F");
    expect(rows()).toContain("Search the output in a terminal = Ctrl+Shift+F");
    expect(rows()).not.toContain("Command palette = Ctrl+P");
    await type("terminal paste");
    expect(rows()).toEqual(["Paste in a terminal = Ctrl+V"]);
    await type("no such thing");
    expect(rows()).toEqual([]);
    expect(document.querySelector('[role="status"]')!.textContent).toBe("No shortcut matches.");
  });

  it("shows a changed shortcut with its default, and follows a remap while open", async () => {
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    await act(async () => setOverrides({ "note.new": "Mod+Shift+J" }));
    const row = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent!.startsWith("New note"))!;
    expect(row.textContent).toContain("Ctrl+Shift+J");
    expect(row.textContent).toContain("default Ctrl+N");
    await type("shift j");
    expect(rows()).toEqual(["New note = Ctrl+Shift+J"]);
  });

  it("spells keys for macOS, and shows the hotkey the app registered or that it is off", async () => {
    setMacForTests(true);
    hotkey = "CommandOrControl+Alt+Shift+M";
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    expect(rows()).toContain("Command palette = Cmd+P");
    expect(rows()).toContain("Quick capture window from anywhere = Cmd+Option+Shift+M");
    await act(async () => useShortcutsDialog.getState().hide());
    hotkey = null;
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    expect(rows()).toContain("Quick capture window from anywhere = Off");
  });

  it("says Not registered when the system refused the Quick capture hotkey", async () => {
    hotkeyError = "Could not register CommandOrControl+Alt+M";
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    expect(rows()).toContain("Quick capture window from anywhere = Not registered");
  });

  it("Escape and the button close it, and the Settings button opens Settings at the section", async () => {
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(useShortcutsDialog.getState().open).toBe(false);
    await act(async () => useShortcutsDialog.getState().show());
    const change = [...document.querySelectorAll("button")].find((b) => b.textContent === "Change shortcuts in Settings")!;
    await act(async () => change.click());
    expect(useShortcutsDialog.getState().open).toBe(false);
    expect(useApp.getState().settings).toEqual({ section: "shortcuts" });
    useApp.setState({ settings: null });
  });
});

describe("under React Strict Mode", () => {
  it("keeps the focus in the filter box while open and gives it back to the opener only on close", async () => {
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<StrictMode><button id="opener">Opener</button><ShortcutsDialog /></StrictMode>));
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    await act(async () => useShortcutsDialog.getState().show());
    await settle();
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Filter shortcuts"]'));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("matchesFilter", () => {
  it("needs every word, in any order, ignoring case and +", () => {
    const s = shortcut("search.alt")!;
    expect(matchesFilter(s, "", "Ctrl+Shift+F")).toBe(true);
    expect(matchesFilter(s, "SHIFT ctrl", "Ctrl+Shift+F")).toBe(true);
    expect(matchesFilter(s, "ctrl+shift+f", "Ctrl+Shift+F")).toBe(true);
    expect(matchesFilter(s, "ctrl alt", "Ctrl+Shift+F")).toBe(false);
  });
});
