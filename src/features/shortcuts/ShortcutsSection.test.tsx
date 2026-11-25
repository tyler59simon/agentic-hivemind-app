// @vitest-environment jsdom
// Remapping in Settings (DESK-KEYS): record a combo, see a clash refused or warned, reset one row or all, and follow a change
// another window made. The Rust side is stood in for by a map that keeps what shortcuts_set is given.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stored: Record<string, string> = {};
let refuse: string | null = null;
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
    if (cmd === "shortcuts_reset") { stored = {}; return stored; }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { ShortcutsSection } = await import("./ShortcutsSection");
const { useShortcutsDialog } = await import("./ShortcutsDialog");
const { Announcer } = await import("../../ui/announce");
const { setOverrides, format } = await import("../../lib/shortcuts");

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
  calls.length = 0;
  setOverrides({});
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<><ShortcutsSection /><Announcer /></>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
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
    expect(text()).toContain('Ctrl+B also does "Bold" in the editor, and the key will do both there.');
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
    await act(async () => setOverrides({ "zoom.in": "Mod+Shift+Plus" }));
    expect(shownKeys("Zoom in")).toBe("Ctrl+Shift++");
    expect(reset("Zoom in").disabled).toBe(false);
    await act(async () => setOverrides({}));
    expect(shownKeys("Zoom in")).toBe("Ctrl+=");
  });

  it("lets the zoom keys through to the recorder, and has the sheet button", async () => {
    expect(key("Zoom in").hasAttribute("data-own-zoom-keys")).toBe(true);
    const show = [...document.querySelectorAll("button")].find((b) => b.textContent === "Show every shortcut")!;
    await act(async () => show.click());
    expect(useShortcutsDialog.getState().open).toBe(true);
    useShortcutsDialog.getState().hide();
  });
});
