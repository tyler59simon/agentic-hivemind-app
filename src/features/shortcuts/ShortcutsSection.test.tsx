// @vitest-environment jsdom
// Remapping in Settings (DESK-KEYS): record a combo, see a clash refused or warned, reset one row or all, and follow a change
// another window made. The Rust side is stood in for by a map that keeps what shortcuts_set is given.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stored: Record<string, string> = {};
let refuse: string | null = null;
let refuseReset: string | null = null;
let capture: { shortcut: string | null; error: string | null } = { shortcut: null, error: null };
const calls: { cmd: string; args?: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { id: string; combo: string | null }) => {
    calls.push({ cmd, args });
    if (cmd === "shortcuts_set") {
      if (refuse) throw refuse;
      stored = { ...stored };
      if (args!.combo) stored[args!.id] = args!.combo; else delete stored[args!.id];
      return stored;
    }
    if (cmd === "shortcuts_reset") { if (refuseReset) throw refuseReset; stored = {}; return stored; }
    if (cmd === "capture_status") return { ...capture, close_to_tray: true };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { ShortcutsSection } = await import("./ShortcutsSection");
const { useShortcutsDialog } = await import("./ShortcutsDialog");
const { Announcer } = await import("../../ui/announce");
const { setOverrides, format, refreshCapture } = await import("../../lib/shortcuts");
const { ShortcutsDialog } = await import("./ShortcutsDialog");
const { useApp } = await import("../../store");

let root: Root | null = null;
const key = (label: string) => document.querySelector<HTMLButtonElement>(`button.shortcut-key[aria-label^="${label}:"]`)!;
const reset = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label^="Reset ${label} to"]`)!;
const shownKeys = (label: string) => key(label).textContent;
const said = () => document.querySelector('[data-announce="polite"]')!.textContent;
const saidNow = () => document.querySelector('[data-announce="assertive"]')!.textContent;
const text = () => document.querySelector("#settings-shortcuts")!.textContent!;
const sets = () => calls.filter((c) => c.cmd === "shortcuts_set").map((c) => c.args);
const start = async (label: string) => { await act(async () => key(label).click()); };
const press = async (label: string, k: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  await act(async () => { key(label).dispatchEvent(e); });
  return e;
};

beforeEach(async () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  stored = {};
  refuse = null;
  refuseReset = null;
  capture = { shortcut: null, error: null };
  calls.length = 0;
  setOverrides({});
  await refreshCapture();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<><button id="other">Other</button><ShortcutsSection /><ShortcutsDialog /><Announcer /></>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  useShortcutsDialog.getState().hide();
  useApp.setState({ settings: null });
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

describe("the Settings section", () => {
  it("lists the shortcuts that can change, by group, and leaves out the fixed ones", () => {
    expect(document.getElementById("settings-shortcuts")).not.toBeNull();
    expect([...document.querySelectorAll("#settings-shortcuts h4")].map((h) => h.textContent)).toEqual(["Navigation", "Notes", "Tabs and panes", "Window"]);
    expect(shownKeys("Command palette")).toBe("Ctrl+P");
    expect(shownKeys("Zoom in")).toBe("Ctrl+=");
    for (const fixed of ["Save the file", "Next tab", "Bold", "Paste"]) expect(document.querySelector(`button[aria-label^="${fixed}:"]`), fixed).toBeNull();
    expect(reset("Command palette").disabled).toBe(true);
  });

  it("records the next combination: click, press the keys, and it is kept and announced", async () => {
    await start("New note");
    expect(shownKeys("New note")).toBe("Press the new keys…");
    const e = await press("New note", "j", { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(sets()).toEqual([{ id: "note.new", combo: "Mod+J" }]);
    expect(shownKeys("New note")).toBe("Ctrl+J");
    expect(said()).toBe("New note is now Ctrl+J.");
    expect(format("note.new")).toBe("Ctrl+J");
  });

  it("ignores a lone modifier and keeps recording", async () => {
    await start("New note");
    await press("New note", "Control", { ctrlKey: true });
    expect(sets()).toEqual([]);
    expect(shownKeys("New note")).toBe("Press the new keys…");
  });

  it("Escape cancels without a change, and Tab leaves the field", async () => {
    await start("New note");
    await press("New note", "Escape");
    expect(shownKeys("New note")).toBe("Ctrl+N");
    expect(said()).toBe("Cancelled.");
    await start("New note");
    const tab = await press("New note", "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(shownKeys("New note")).toBe("Ctrl+N");
    expect(sets()).toEqual([]);
  });

  it("does not record a key while it is not recording", async () => {
    await press("New note", "j", { ctrlKey: true });
    expect(sets()).toEqual([]);
  });

  it("refuses a combo another app shortcut has, and says which", async () => {
    await start("New note");
    await press("New note", "o", { ctrlKey: true });
    expect(text()).toContain('Ctrl+O is already used for "Go to note".');
    expect(saidNow()).toBe('Ctrl+O is already used for "Go to note".');
    expect(sets()).toEqual([]);
    expect(shownKeys("New note")).toBe("Press the new keys…"); // still recording: try another
    expect(key("New note").getAttribute("aria-describedby")).toBe("shortcut-note-note.new");
    await press("New note", "j", { ctrlKey: true });
    expect(shownKeys("New note")).toBe("Ctrl+J");
    expect(text()).not.toContain("already used");
  });

  it("refuses a reserved key, a fixed shortcut's key and a combo with no modifier", async () => {
    await start("New note");
    await press("New note", "c", { ctrlKey: true });
    expect(text()).toContain("Ctrl+C is reserved for the system and cannot be used.");
    await press("New note", "s", { ctrlKey: true });
    expect(text()).toContain('Ctrl+S is already used for "Save the file".');
    await press("New note", "F5");
    expect(sets()).toEqual([]);
    expect(text()).toContain("F5 is reserved");
    await press("New note", "j");
    expect(text()).toContain("Use Ctrl, Alt or Cmd with a key");
    expect(sets()).toEqual([]);
  });

  it("keeps a combo an editor also uses, with a warning", async () => {
    await start("New note");
    await press("New note", "b", { ctrlKey: true });
    expect(sets()).toEqual([{ id: "note.new", combo: "Mod+B" }]);
    expect(text()).toContain('Ctrl+B also does "Bold" in the editor, and both run there.');
    expect(said()).toContain("New note is now Ctrl+B.");
  });

  it("shows what Rust refuses", async () => {
    refuse = "That is not a key combination Hivemind can use.";
    await start("New note");
    await press("New note", "j", { ctrlKey: true });
    expect(text()).toContain("That is not a key combination Hivemind can use.");
    expect(shownKeys("New note")).toBe("Ctrl+N");
  });

  it("keeps the default as no override", async () => {
    await start("New note");
    await press("New note", "j", { ctrlKey: true });
    await start("New note");
    await press("New note", "n", { ctrlKey: true });
    expect(sets()).toEqual([{ id: "note.new", combo: "Mod+J" }, { id: "note.new", combo: null }]);
    expect(Object.keys(stored)).toEqual([]);
  });

  it("resets one row, and all of them", async () => {
    await start("New note");
    await press("New note", "j", { ctrlKey: true });
    await start("Open the graph");
    await press("Open the graph", "k", { altKey: true });
    expect(shownKeys("Open the graph")).toBe("Alt+K");
    expect(reset("New note").disabled).toBe(false);
    await act(async () => reset("New note").click());
    expect(shownKeys("New note")).toBe("Ctrl+N");
    expect(said()).toBe("New note is back to Ctrl+N.");
    expect(shownKeys("Open the graph")).toBe("Alt+K");
    const all = [...document.querySelectorAll("button")].find((b) => b.textContent === "Reset all")!;
    await act(async () => all.click());
    expect(shownKeys("Open the graph")).toBe("Ctrl+G");
    expect(stored).toEqual({});
    expect(said()).toBe("All shortcuts are back to their defaults.");
    expect(all.disabled).toBe(true);
  });

  it("follows a change from another window", async () => {
    await act(async () => setOverrides({ "zoom.in": "Mod+Alt+Z" }));
    expect(shownKeys("Zoom in")).toBe("Ctrl+Alt+Z");
    expect(reset("Zoom in").disabled).toBe(false);
    await act(async () => setOverrides({}));
    expect(shownKeys("Zoom in")).toBe("Ctrl+=");
  });

  it("says who wins when an editor, a terminal or the zoom keys also use the key", async () => {
    await start("Switch between Reading and editing");
    await press("Switch between Reading and editing", "b", { ctrlKey: true });
    expect(text()).toContain('Ctrl+B also does "Bold" in the editor, and there the editor wins.');
    await start("Zoom in");
    await press("Zoom in", "i", { ctrlKey: true });
    expect(text()).toContain('also does "Italic" in the editor, but the app takes the key first, so it only zooms.');
    await start("New note");
    await press("New note", "K", { ctrlKey: true, shiftKey: true });
    expect(text()).toContain('Ctrl+Shift+K also does "Move the focus out of the terminal" in a terminal, and there the terminal wins and this action does not run.');
  });

  it("sees Ctrl+Shift++ as the zoom key it is, and refuses Ctrl+Enter (Quick capture submits with it)", async () => {
    await start("New note");
    await press("New note", "+", { ctrlKey: true, shiftKey: true });
    expect(text()).toContain('Ctrl+= is already used for "Zoom in".');
    await press("New note", "Enter", { ctrlKey: true });
    expect(text()).toContain("Ctrl+Enter is reserved for the system and cannot be used.");
    expect(sets()).toEqual([]);
  });

  it("refuses the Quick capture hotkey while it is registered", async () => {
    capture = { shortcut: "CommandOrControl+Alt+M", error: null };
    await refreshCapture();
    await start("New note");
    await press("New note", "m", { ctrlKey: true, altKey: true });
    expect(text()).toContain("Ctrl+Alt+M is the Quick capture hotkey.");
    expect(sets()).toEqual([]);
    capture = { shortcut: "CommandOrControl+Alt+M", error: "Could not register" };
    await refreshCapture();
    await press("New note", "m", { ctrlKey: true, altKey: true });
    expect(sets()).toEqual([{ id: "note.new", combo: "Mod+Alt+M" }]);
  });

  it("names the shortcut that Rust says holds the combo", async () => {
    refuse = "taken:graph.open";
    await start("New note");
    await press("New note", "j", { ctrlKey: true });
    expect(text()).toContain('Ctrl+J is already used for "Open the graph".');
  });

  it("does not reset a row whose default another shortcut has taken", async () => {
    // The file holds a clash that the recorder would have refused: Open the graph sits on Ctrl+N.
    await act(async () => setOverrides({ "note.new": "Mod+J", "graph.open": "Mod+N" }));
    expect(reset("New note").disabled).toBe(false);
    await act(async () => reset("New note").click());
    expect(sets()).toEqual([]);
    expect(text()).toContain('Not reset. Ctrl+N is already used for "Open the graph".');
    expect(saidNow()).toContain("Not reset.");
    expect(shownKeys("New note")).toBe("Ctrl+J");
    // Resetting the one that took it frees it.
    await act(async () => reset("Open the graph").click());
    await act(async () => reset("New note").click());
    expect(shownKeys("New note")).toBe("Ctrl+N");
  });

  it("swallows the recorded key until it is let go, so holding it does not run the new shortcut", async () => {
    await start("New note");
    await press("New note", "j", { ctrlKey: true, code: "KeyJ" });
    const again = await press("New note", "j", { ctrlKey: true, code: "KeyJ", repeat: true });
    expect(again.defaultPrevented).toBe(true);
    await act(async () => { key("New note").dispatchEvent(new KeyboardEvent("keyup", { key: "j", code: "KeyJ", bubbles: true })); });
    const later = await press("New note", "j", { ctrlKey: true, code: "KeyJ" });
    expect(later.defaultPrevented).toBe(false);
  });

  it("puts the focus on the recorder when recording starts, even when it had not moved there", async () => {
    const other = document.getElementById("other") as HTMLButtonElement;
    other.focus();
    expect(document.activeElement).toBe(other);
    await start("New note");
    expect(document.activeElement).toBe(key("New note"));
  });

  it("Reset all is for an effective override only, moves the focus to the heading and says when it fails", async () => {
    const all = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Reset all")!;
    // Not remappable, not usable and equal to the default: none of these is an override that does anything.
    await act(async () => setOverrides({ "file.save": "Mod+Shift+S", nonsense: "Mod+Q", "graph.open": "Mod+G", "note.new": "N" }));
    expect(all().disabled).toBe(true);
    await act(async () => setOverrides({ "note.new": "Mod+J" }));
    expect(all().disabled).toBe(false);
    refuseReset = "settings file is read-only";
    (document.getElementById("other") as HTMLButtonElement).focus();
    await act(async () => all().click());
    expect(text()).toContain("settings file is read-only");
    expect(saidNow()).toBe("settings file is read-only");
    expect(shownKeys("New note")).toBe("Ctrl+J");
    refuseReset = null;
    await act(async () => all().click());
    expect(document.activeElement).toBe(document.getElementById("shortcuts-title"));
    expect(shownKeys("New note")).toBe("Ctrl+N");
  });

  it("the sheet's Settings button focuses the section heading, not the control that opened the sheet", async () => {
    const other = document.getElementById("other") as HTMLButtonElement;
    other.focus();
    await act(async () => useShortcutsDialog.getState().show());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const change = [...document.querySelectorAll("button")].find((b) => b.textContent === "Change shortcuts in Settings")!;
    await act(async () => change.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useApp.getState().settings).toEqual({ section: "shortcuts" });
    expect(document.activeElement).toBe(document.getElementById("shortcuts-title"));
  });

  it("closing the sheet gives the focus back to the control that opened it", async () => {
    const other = document.getElementById("other") as HTMLButtonElement;
    other.focus();
    await act(async () => useShortcutsDialog.getState().show());
    expect(document.activeElement).not.toBe(other);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(other);
  });

  it("lets the zoom keys through to the recorder, and has the sheet button", async () => {
    expect(key("Zoom in").hasAttribute("data-own-zoom-keys")).toBe(true);
    const show = [...document.querySelectorAll("button")].find((b) => b.textContent === "Show every shortcut")!;
    await act(async () => show.click());
    expect(useShortcutsDialog.getState().open).toBe(true);
    useShortcutsDialog.getState().hide();
  });

  // R2: F11 saved for the palette before Full screen existed. The saved key wins; Full screen says who has it, and Reset says why not.
  it("shows a shortcut whose default another one took as not set, names who took it, and refuses its Reset", async () => {
    await act(async () => setOverrides({ "palette.commands": "F11" }));
    expect(shownKeys("Command palette")).toBe("F11");
    expect(shownKeys("Full screen")).toBe("Not set, taken by Command palette");
    expect(key("Full screen").getAttribute("aria-label")).toBe("Full screen: Not set, taken by Command palette. Press Enter to change");
    expect(reset("Full screen").disabled).toBe(false);
    await act(async () => reset("Full screen").click());
    expect(sets()).toEqual([]);
    expect(saidNow()).toBe('Not reset. F11 is already used for "Command palette".');
    await act(async () => useShortcutsDialog.getState().show());
    expect(document.body.textContent).toContain("Not set, taken by Command palette");
    useShortcutsDialog.getState().hide();
  });
});
