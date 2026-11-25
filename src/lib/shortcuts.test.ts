// @vitest-environment jsdom
// The shortcut registry (DESK-KEYS): combo syntax, matching, macOS spelling, conflicts, and following the settings file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (e: { payload: unknown }) => void>();
let stored: Record<string, string> = {};
// While set, an answer waits for it: the answer is made first, so it is older than anything that happens meanwhile.
let gate: Promise<void> | null = null;
let capture: { shortcut: string | null; error: string | null } | null = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { id?: string; combo?: string | null }) => {
    if (cmd === "capture_status") return capture;
    let answer: Record<string, string> | null = null;
    if (cmd === "shortcuts_get") answer = { ...stored };
    if (cmd === "shortcuts_set") {
      stored = { ...stored };
      if (args?.combo) stored[args.id!] = args.combo; else delete stored[args!.id!];
      answer = { ...stored };
    }
    if (cmd === "shortcuts_reset") { stored = {}; answer = {}; }
    if (gate) await gate;
    return answer;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => { listeners.set(name, cb); return () => listeners.delete(name); }),
}));

const S = await import("./shortcuts");
const { setMacForTests } = await import("./platform");

const key = (k: string, mods: Partial<KeyboardEventInit & { code: string }> = {}) => ({ key: k, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

beforeEach(() => { setMacForTests(false); S.setOverrides({}); stored = {}; gate = null; capture = null; });
afterEach(() => { setMacForTests(false); S.setOverrides({}); delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; listeners.clear(); });

describe("parse and normalize", () => {
  it("reads modifiers and one key, and refuses anything else", () => {
    expect(S.parse("Mod+Shift+F")).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: "F" });
    expect(S.parse("Alt+ArrowLeft")).toMatchObject({ alt: true, key: "ArrowLeft" });
    // Punctuation is loose: Shift does not count and Plus and _ fold to = and -.
    expect(S.parse("Mod+Plus")).toMatchObject({ key: "=", shift: false });
    expect(S.parse("Mod+Shift+_")).toMatchObject({ key: "-", shift: false });
    expect(S.parse("Mod+Shift+F")).toMatchObject({ key: "F", shift: true });
    expect(S.parse("Alt+Shift+ArrowUp")).toMatchObject({ key: "ArrowUp", shift: true });
    expect(S.parse("F5")).toMatchObject({ key: "F5" });
    for (const bad of ["", "Mod+", "Mod++", "Mod+p", "Mod+Mod+P", "Win+P", "Mod+Shift", "Mod+F13", "Mod+Esc"]) expect(S.parse(bad), bad).toBeNull();
  });

  it("drops Shift from punctuation and digits, and keeps it on letters and named keys", () => {
    expect(S.normalize("Mod+Shift+Plus")).toBe("Mod+=");
    expect(S.normalize("Mod+Shift+=")).toBe("Mod+=");
    expect(S.normalize("Shift+Mod+_")).toBe("Mod+-");
    expect(S.normalize("Mod+Shift+/")).toBe("Mod+/");
    expect(S.normalize("Alt+Shift+1")).toBe("Alt+1");
    expect(S.normalize("Mod+Shift+F")).toBe("Mod+Shift+F");
    expect(S.normalize("Mod+Shift+Enter")).toBe("Mod+Shift+Enter");
    expect(S.normalize("Ctrl+Shift+Tab")).toBe("Mod+Shift+Tab");
  });

  it("puts a combo in one spelling, and on Windows treats Ctrl as Mod", () => {
    expect(S.normalize("Shift+Mod+F")).toBe("Mod+Shift+F");
    expect(S.normalize("Ctrl+Tab")).toBe("Mod+Tab");
    setMacForTests(true);
    expect(S.normalize("Ctrl+Tab")).toBe("Ctrl+Tab");
    expect(S.normalize("Ctrl+Mod+Tab")).toBe("Mod+Ctrl+Tab");
  });

  it("only binds a key with a modifier other than Shift, or a function key", () => {
    expect(S.usable("Mod+J")).toBe(true);
    expect(S.usable("Alt+J")).toBe(true);
    expect(S.usable("F9")).toBe(true);
    expect(S.usable("J")).toBe(false);
    expect(S.usable("Shift+J")).toBe(false);
    expect(S.usable("Tab")).toBe(false);
  });
});

describe("matches", () => {
  it("matches every default combo, and nothing with another modifier", () => {
    expect(S.matches(key("p", { ctrlKey: true }), "palette.commands")).toBe(true);
    expect(S.matches(key("P", { ctrlKey: true }), "palette.commands")).toBe(true);
    expect(S.matches(key("p", { ctrlKey: true, shiftKey: true }), "palette.commands")).toBe(false);
    expect(S.matches(key("p", { ctrlKey: true, altKey: true }), "palette.commands")).toBe(false); // AltGr
    expect(S.matches(key("p"), "palette.commands")).toBe(false);
    expect(S.matches(key("f", { ctrlKey: true, shiftKey: true }), "search.alt")).toBe(true);
    expect(S.matches(key("ArrowLeft", { altKey: true }), "nav.back")).toBe(true);
    expect(S.matches(key("/", { ctrlKey: true }), "shortcuts.show")).toBe(true);
    expect(S.matches(key("\\", { ctrlKey: true }), "view.split")).toBe(true);
    expect(S.matches(key("Tab", { ctrlKey: true }), "tab.next")).toBe(true);
    expect(S.matches(key("Tab", { ctrlKey: true, shiftKey: true }), "tab.prev")).toBe(true);
    expect(S.matches(key("Tab", { ctrlKey: true, shiftKey: true }), "tab.next")).toBe(false);
  });

  it("takes Ctrl as Mod off macOS (never the Windows key), and only Cmd as Mod on macOS", () => {
    expect(S.matches(key("o", { ctrlKey: true }), "palette.notes")).toBe(true);
    expect(S.matches(key("o", { metaKey: true }), "palette.notes")).toBe(false);
    expect(S.matches(key("o", { ctrlKey: true, metaKey: true }), "palette.notes")).toBe(false);
    setMacForTests(true);
    expect(S.matches(key("o", { metaKey: true }), "palette.notes")).toBe(true);
    expect(S.matches(key("o", { ctrlKey: true }), "palette.notes")).toBe(false);
    expect(S.matches(key("o", { metaKey: true, ctrlKey: true }), "palette.notes")).toBe(false);
    // Ctrl+Tab stays Ctrl on macOS, where Cmd+Tab switches apps.
    expect(S.matches(key("Tab", { ctrlKey: true }), "tab.next")).toBe(true);
    expect(S.matches(key("Tab", { metaKey: true }), "tab.next")).toBe(false);
  });

  it("does not count Shift for punctuation: + is Shift+= and _ is Shift+-, and the combos fold to one key", () => {
    expect(S.matches(key("=", { ctrlKey: true }), "zoom.in")).toBe(true);
    expect(S.matches(key("+", { ctrlKey: true, shiftKey: true }), "zoom.in")).toBe(true);
    expect(S.matches(key("=", { ctrlKey: true, shiftKey: true }), "zoom.in")).toBe(true);
    expect(S.matches(key("-", { ctrlKey: true }), "zoom.out")).toBe(true);
    expect(S.matches(key("_", { ctrlKey: true, shiftKey: true }), "zoom.out")).toBe(true);
    expect(S.matches(key("0", { ctrlKey: true }), "zoom.reset")).toBe(true);
    expect(S.matches(key("0", { ctrlKey: true, shiftKey: true }), "zoom.reset")).toBe(true); // a layout where 0 needs Shift
    expect(S.matches(key("=", { ctrlKey: true, altKey: true }), "zoom.in")).toBe(false);
    expect(S.matches(key("9", { ctrlKey: true }), "zoom.reset")).toBe(false);
    // Letters and named keys keep Shift.
    expect(S.matches(key("P", { ctrlKey: true, shiftKey: true }), "palette.commands")).toBe(false);
    expect(S.matches(key("ArrowUp", { altKey: true }), "editor.column-up")).toBe(false);
    expect(S.matches(key("ArrowUp", { altKey: true, shiftKey: true }), "editor.column-up")).toBe(true);
  });

  it("reads a letter from the physical key only on macOS with Option held", () => {
    expect(S.eventKey(key("m", { code: "KeyM" }))).toBe("M");
    // Elsewhere the character is the key, so another layout keeps its own letters.
    expect(S.eventKey(key("\u03bc", { altKey: true, code: "KeyM" }))).toBe("\u039c");
    setMacForTests(true);
    expect(S.eventKey(key("\u00b5", { altKey: true, code: "KeyM" }))).toBe("M");
    expect(S.eventKey(key("1", { altKey: true, code: "Digit1" }))).toBe("1");
    expect(S.eventKey(key("m", { code: "KeyM" }))).toBe("M");
  });

  it("reads nothing from composition, a dead key, a Process key or AltGr", () => {
    const base = { ctrlKey: true };
    expect(S.matches({ ...key("p", base), isComposing: true }, "palette.commands")).toBe(false);
    expect(S.matches(key("Dead", base), "palette.commands")).toBe(false);
    expect(S.matches(key("Process", base), "palette.commands")).toBe(false);
    const altGr = { ...key("p", { ctrlKey: true, altKey: true }), getModifierState: (k: string) => k === "AltGraph" };
    expect(S.matches(altGr, "palette.commands")).toBe(false);
    expect(S.comboOf(altGr)).toBeNull();
    expect(S.comboOf({ ...key("j", base), isComposing: true })).toBeNull();
    expect(S.comboOf(key("Dead", base))).toBeNull();
    expect(S.comboOf(key("Process", base))).toBeNull();
    // The same key without the flag is read.
    expect(S.matches({ ...key("p", base), getModifierState: () => false }, "palette.commands")).toBe(true);
  });

  it("ignores key repeat except for zoom and tab cycling", () => {
    expect(S.matches({ ...key("p", { ctrlKey: true }), repeat: true }, "palette.commands")).toBe(false);
    expect(S.matches({ ...key("p", { ctrlKey: true }), repeat: false }, "palette.commands")).toBe(true);
    expect(S.matches({ ...key("=", { ctrlKey: true }), repeat: true }, "zoom.in")).toBe(true);
    expect(S.matches({ ...key("-", { ctrlKey: true }), repeat: true }, "zoom.out")).toBe(true);
    expect(S.matches({ ...key("Tab", { ctrlKey: true }), repeat: true }, "tab.next")).toBe(true);
    expect(S.matches({ ...key("Tab", { ctrlKey: true, shiftKey: true }), repeat: true }, "tab.prev")).toBe(true);
    expect(S.matches({ ...key("0", { ctrlKey: true }), repeat: true }, "zoom.reset")).toBe(false);
  });

  it("follows an override, ignores one that cannot be used, and never moves a fixed shortcut", () => {
    S.setOverrides({ "note.new": "Mod+J", "graph.open": "G", "file.save": "Mod+Shift+S", "nonsense": "Mod+Q" });
    expect(S.matches(key("j", { ctrlKey: true }), "note.new")).toBe(true);
    expect(S.matches(key("n", { ctrlKey: true }), "note.new")).toBe(false);
    expect(S.matches(key("g", { ctrlKey: true }), "graph.open")).toBe(true); // "G" has no modifier: the default stays
    expect(S.matches(key("s", { ctrlKey: true }), "file.save")).toBe(true);  // not remappable
    expect(S.matches(key("q", { ctrlKey: true }), "nonsense")).toBe(false);
  });
});

describe("format", () => {
  it("spells the combo for the platform", () => {
    expect(S.format("palette.commands")).toBe("Ctrl+P");
    expect(S.format("nav.back")).toBe("Alt+Left");
    expect(S.format("search.alt")).toBe("Ctrl+Shift+F");
    expect(S.format("zoom.in")).toBe("Ctrl+=");
    expect(S.format("view.split")).toBe("Ctrl+\\");
    setMacForTests(true);
    expect(S.format("palette.commands")).toBe("Cmd+P");
    expect(S.format("nav.back")).toBe("Option+Left");
    expect(S.format("search.alt")).toBe("Cmd+Shift+F");
    expect(S.format("tab.next")).toBe("Ctrl+Tab");
    expect(S.formatCombo(S.defaultCombo("global.capture"))).toBe("Cmd+Option+Shift+M");
  });

  it("shows an override", () => {
    const seen: string[] = [];
    S.setOverrides({ "palette.commands": "Mod+Shift+P" });
    seen.push(S.format("palette.commands"));
    S.setOverrides({});
    seen.push(S.format("palette.commands"));
    expect(seen).toEqual(["Ctrl+Shift+P", "Ctrl+P"]);
  });

  it("reads Tauri's accelerator text as a combo", () => {
    expect(S.formatCombo(S.fromAccelerator("CommandOrControl+Alt+M"))).toBe("Ctrl+Alt+M");
    expect(S.formatCombo(S.fromAccelerator("Ctrl+Shift+Q"))).toBe("Ctrl+Shift+Q");
    expect(S.fromAccelerator("Ctrl+Nonsense")).toBe("Ctrl+Nonsense");
  });
});

describe("the Quick capture accelerator as a combo", () => {
  it("reads the spellings the global-hotkey crate takes, in any case", () => {
    for (const [accelerator, combo] of [
      ["CommandOrControl+Alt+M", "Mod+Alt+M"], ["cmdorctrl+alt+m", "Mod+Alt+M"], ["CmdOrControl+Shift+KeyN", "Mod+Shift+N"], ["CommandOrCtrl+Digit5", "Mod+5"],
      ["Control+KeyN", "Mod+N"], ["Ctrl+Alt+F9", "Mod+Alt+F9"], ["Option+Shift+j", "Alt+Shift+J"], ["Ctrl+Space", "Mod+Space"], ["Ctrl+Left", "Mod+ArrowLeft"],
      ["Ctrl+Esc", "Mod+Escape"], ["Ctrl+/", "Mod+/"],
    ]) expect(S.acceleratorCombo(accelerator), accelerator).toBe(combo);
    for (const unknown of ["", "M", "Ctrl+Hyper+M", "Ctrl+F99", "Ctrl+Nonsense", "Ctrl+"]) expect(S.acceleratorCombo(unknown), unknown).toBeNull();
  });

  it("conflicts when the spelling differs but the key is the same", async () => {
    capture = { shortcut: "Control+KeyN", error: null };
    await S.refreshCapture();
    expect(S.conflicts("Mod+N", "graph.open")).toEqual([{ kind: "global", with: "Quick capture hotkey", refuse: true }, { kind: "app", with: "New note", refuse: true }]);
  });

  it("treats Super, Cmd, Command and Meta as the Windows key off macOS: no app combo clashes with it", async () => {
    for (const spelling of ["Super+Alt+J", "Meta+Alt+J", "Command+Alt+J", "Cmd+Alt+J"]) {
      capture = { shortcut: spelling, error: null };
      await S.refreshCapture();
      expect(S.captureCombo(), spelling).toBeNull();
      expect(S.conflicts("Mod+Alt+J", "note.new"), spelling).toEqual([]);
      expect(S.conflicts("Alt+J", "note.new"), spelling).toEqual([]);
    }
  });

  it("treats Super as Cmd on macOS, so Super+Alt+J is Mod+Alt+J", async () => {
    setMacForTests(true);
    capture = { shortcut: "Super+Alt+J", error: null };
    await S.refreshCapture();
    expect(S.captureCombo()).toBe("Mod+Alt+J");
    expect(S.conflicts("Mod+Alt+J", "note.new")).toEqual([{ kind: "global", with: "Quick capture hotkey", refuse: true }]);
    // Ctrl is its own key there.
    expect(S.conflicts("Ctrl+Alt+J", "note.new")).toEqual([]);
  });
});

describe("comboOf", () => {
  it("records a key press as a combo, and nothing for a lone modifier", () => {
    expect(S.comboOf(key("j", { ctrlKey: true }))).toBe("Mod+J");
    expect(S.comboOf(key("J", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe("Mod+Alt+Shift+J");
    expect(S.comboOf(key("ArrowUp", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+ArrowUp");
    expect(S.comboOf(key("Control", { ctrlKey: true }))).toBeNull();
    expect(S.comboOf(key("Shift", { shiftKey: true }))).toBeNull();
    expect(S.comboOf(key("Dead"))).toBeNull();
    setMacForTests(true);
    expect(S.comboOf(key("j", { metaKey: true }))).toBe("Mod+J");
    expect(S.comboOf(key("Tab", { ctrlKey: true }))).toBe("Ctrl+Tab");
  });

  it("records punctuation without Shift, as the one key the matcher reads", () => {
    expect(S.comboOf(key("+", { ctrlKey: true, shiftKey: true }))).toBe("Mod+=");
    expect(S.comboOf(key("=", { ctrlKey: true }))).toBe("Mod+=");
    expect(S.comboOf(key("_", { ctrlKey: true, shiftKey: true }))).toBe("Mod+-");
    expect(S.comboOf(key("?", { ctrlKey: true, shiftKey: true }))).toBe("Mod+?");
  });

  it("does not turn the Windows key into Ctrl off macOS", () => {
    expect(S.comboOf(key("j", { metaKey: true }))).toBeNull();
    expect(S.comboOf(key("j", { ctrlKey: true, metaKey: true }))).toBeNull();
  });
});

describe("conflicts", () => {
  it("refuses the reserved keys and another app shortcut", () => {
    expect(S.conflicts("Mod+C", "note.new")[0]).toEqual({ kind: "reserved", with: "Ctrl+C", refuse: true });
    for (const reserved of ["Mod+V", "Mod+X", "Mod+Z", "Mod+Y", "Mod+A", "Mod+F", "Mod+R", "F5", "Shift+F5", "Mod+Shift+R"]) {
      expect(S.conflicts(reserved, "note.new").some((c) => c.kind === "reserved" && c.refuse), reserved).toBe(true);
    }
    expect(S.conflicts("Mod+O", "note.new")).toEqual([{ kind: "app", with: "Go to note", refuse: true }]);
    // Quick capture's submit chord.
    expect(S.conflicts("Mod+Enter", "note.new")[0]).toMatchObject({ kind: "reserved", refuse: true });
    // Its own combo is not a clash, and a free combo has none.
    expect(S.conflicts("Mod+N", "note.new")).toEqual([]);
    expect(S.conflicts("Mod+J", "note.new")).toEqual([]);
  });

  it("checks against the shortcuts as changed, and against the fixed ones", () => {
    S.setOverrides({ "graph.open": "Mod+J" });
    expect(S.conflicts("Mod+J", "note.new")).toEqual([{ kind: "app", with: "Open the graph", refuse: true }]);
    expect(S.conflicts("Mod+G", "note.new")).toEqual([]);
    expect(S.conflicts("Mod+S", "note.new")).toEqual([{ kind: "app", with: "Save the file", refuse: true }]);
  });

  // DESK-LAYOUT: the sidebar, focus mode and full screen keys clash with nothing (Ctrl+B is the editor's bold, so not that).
  it("has no clash for the layout keys, which are remappable app shortcuts", () => {
    const layout = { "sidebar.toggle": "Mod+Shift+B", "focus.toggle": "Mod+Shift+M", "fullscreen.toggle": "F11" };
    for (const [id, combo] of Object.entries(layout)) {
      expect(S.defaultCombo(id), id).toBe(combo);
      expect(S.shortcut(id)).toMatchObject({ scope: "app", remappable: true });
      expect(S.conflicts(combo, id), id).toEqual([]);
      expect(S.matches(key(combo.split("+").pop()!, { ctrlKey: combo.startsWith("Mod"), shiftKey: combo.includes("Shift") }), id), id).toBe(true);
    }
    expect(S.format("fullscreen.toggle")).toBe("F11");
    expect(S.matches(key("F11", { ctrlKey: true }), "fullscreen.toggle")).toBe(false);
    expect(S.matches(key("F5"), "fullscreen.toggle")).toBe(false);
  });

  it("only warns about an editor or terminal key", () => {
    expect(S.conflicts("Mod+B", "note.new")).toEqual([{ kind: "editor", with: "Bold", refuse: false }]);
    expect(S.conflicts("Mod+Shift+L", "note.new")).toEqual([{ kind: "editor", with: "Select every occurrence", refuse: false }]);
    expect(S.conflicts("Mod+Shift+K", "note.new")).toEqual([{ kind: "terminal", with: "Move the focus out of the terminal", refuse: false }]);
  });

  it("sees one key behind two spellings of punctuation, so Mod+Shift+Plus clashes with zoom in", () => {
    for (const spelling of ["Mod+Shift+Plus", "Mod+Plus", "Mod+Shift+=", "Mod+="]) {
      expect(S.conflicts(spelling, "note.new"), spelling).toEqual([{ kind: "app", with: "Zoom in", refuse: true }]);
    }
    expect(S.conflicts("Mod+Shift+_", "note.new")).toEqual([{ kind: "app", with: "Zoom out", refuse: true }]);
    // Shift stays significant on a letter.
    expect(S.conflicts("Mod+Shift+G", "note.new")).toEqual([]);
  });

  it("refuses the Quick capture hotkey while it is registered, and not when it is off or failed", async () => {
    capture = { shortcut: "CommandOrControl+Alt+M", error: null };
    await S.refreshCapture();
    expect(S.conflicts("Mod+Alt+M", "note.new")).toEqual([{ kind: "global", with: "Quick capture hotkey", refuse: true }]);
    capture = { shortcut: "CommandOrControl+Alt+M", error: "Could not register" };
    await S.refreshCapture();
    expect(S.conflicts("Mod+Alt+M", "note.new")).toEqual([]);
    capture = { shortcut: null, error: null };
    await S.refreshCapture();
    expect(S.conflicts("Mod+Alt+M", "note.new")).toEqual([]);
  });

  it("counts only the remappable shortcuts that differ from their default", () => {
    expect(S.overrideCount()).toBe(0);
    S.setOverrides({ "note.new": "Mod+J", "graph.open": "Mod+G", "file.save": "Mod+Shift+S", nonsense: "Mod+Q", "zoom.in": "Mod+Plus" });
    expect(S.overrideCount()).toBe(1);
  });

  it("reads Ctrl as Mod off macOS, where they are the same key", () => {
    expect(S.conflicts("Ctrl+O", "note.new")).toEqual([{ kind: "app", with: "Go to note", refuse: true }]);
    setMacForTests(true);
    expect(S.conflicts("Ctrl+O", "note.new")).toEqual([]);
  });
});

describe("following the settings file", () => {
  it("reads the saved overrides at start and follows the event of any window", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    stored = { "note.new": "Mod+J" };
    const stop = S.initShortcuts();
    await vi.waitFor(() => expect(S.format("note.new")).toBe("Ctrl+J"));
    listeners.get("shortcuts")!({ payload: { "note.new": "Mod+K", "graph.open": "Alt+G" } });
    expect(S.format("note.new")).toBe("Ctrl+K");
    expect(S.format("graph.open")).toBe("Alt+G");
    listeners.get("shortcuts")!({ payload: {} });
    expect(S.format("note.new")).toBe("Ctrl+N");
    stop();
  });

  it("drops a start-up read that answers after a newer event", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    stored = { "note.new": "Mod+J" };
    let release = () => {};
    gate = new Promise<void>((r) => { release = r; });
    const stop = S.initShortcuts();
    await vi.waitFor(() => expect(listeners.has("shortcuts")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    listeners.get("shortcuts")!({ payload: { "note.new": "Mod+K" } });
    gate = null;
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(S.format("note.new")).toBe("Ctrl+K");
    stop();
  });

  it("drops a save response that answers after a newer event", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const stop = S.initShortcuts();
    await vi.waitFor(() => expect(listeners.has("shortcuts")).toBe(true));
    await new Promise((r) => setTimeout(r, 10));
    let release = () => {};
    gate = new Promise<void>((r) => { release = r; });
    const saving = S.saveShortcut("note.new", "Mod+J");
    await new Promise((r) => setTimeout(r, 0));
    // Another window changes a different shortcut before the answer to this save arrives.
    listeners.get("shortcuts")!({ payload: { "graph.open": "Alt+G" } });
    gate = null;
    release();
    await saving;
    // The older answer ({note.new}) did not replace the newer event ({graph.open}).
    expect(S.format("graph.open")).toBe("Alt+G");
    expect(S.format("note.new")).toBe("Ctrl+N");
    stop();
  });

  it("keeps a change through shortcuts_set and goes back through null and reset", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    await S.saveShortcut("note.new", "Mod+J");
    expect(S.format("note.new")).toBe("Ctrl+J");
    expect(S.overrideCount()).toBe(1);
    await S.saveShortcut("note.new", null);
    expect(S.format("note.new")).toBe("Ctrl+N");
    await S.saveShortcut("graph.open", "Mod+J");
    await S.resetShortcuts();
    expect(S.overrideCount()).toBe(0);
  });
});
