// Keyboard shortcuts (DESK-KEYS): one registry for the keys the app handles itself, with a reference sheet and remapping in
// Settings. A combo is text such as `Mod+Shift+F`: modifiers in the order Mod, Ctrl, Alt, Shift, then one key. `Mod` is
// Ctrl on Windows and Linux and Cmd on macOS (the same rule as `commandKey`); `Ctrl` is the Control key everywhere.
// Rust keeps the overrides in the settings file (`shortcuts_get`, `shortcuts_set`, `shortcuts_reset`) and tells every
// window with `shortcuts`, so a handler only asks `matches(event, id)` when a key is pressed. No copy is kept for the
// first paint: nothing is drawn from it before the first read, which takes a few milliseconds.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { inTauri } from "./native";
import { isMac, modKey } from "./platform";

/** Where a shortcut works: `app` ones can be changed, `editor` and `terminal` ones belong to those views, `global` is the
 *  operating system hotkey that opens quick capture. */
export type Scope = "app" | "editor" | "terminal" | "global";

export interface Shortcut {
  id: string;
  label: string;
  group: string;
  default: string;
  /** The default on macOS, when it differs. */
  mac?: string;
  scope: Scope;
  /** Whether Settings can change it. Only app shortcuts can be. */
  remappable: boolean;
}

const app = (id: string, label: string, group: string, combo: string, remappable = true): Shortcut => ({ id, label, group, default: combo, scope: "app", remappable });
const editor = (id: string, label: string, combo: string): Shortcut => ({ id, label, group: "Editor", default: combo, scope: "editor", remappable: false });
const terminal = (id: string, label: string, combo: string): Shortcut => ({ id, label, group: "Terminal", default: combo, scope: "terminal", remappable: false });

/** Every shortcut, in the order the reference sheet shows them. The editor keys mirror CodeEditor.tsx, toolbar.tsx and
 *  power/extensions.ts (plus the editor's own Ctrl+/), the terminal keys mirror terminal/keys.ts. */
export const SHORTCUTS: readonly Shortcut[] = [
  app("palette.commands", "Command palette", "Navigation", "Mod+P"),
  app("palette.notes", "Go to note", "Navigation", "Mod+O"),
  app("search.focus", "Search notes and pages", "Navigation", "Mod+K"),
  app("search.alt", "Search notes and pages (second key)", "Navigation", "Mod+Shift+F"),
  app("nav.back", "Back", "Navigation", "Alt+ArrowLeft"),
  app("shortcuts.show", "Keyboard shortcuts", "Navigation", "Mod+/"),
  app("note.new", "New note", "Notes", "Mod+N"),
  app("graph.open", "Open the graph", "Notes", "Mod+G"),
  app("capture.open", "Capture to memory (on Home)", "Notes", "Mod+Shift+C"),
  app("tab.close", "Close the tab", "Tabs and panes", "Mod+W"),
  app("tab.next", "Next tab", "Tabs and panes", "Ctrl+Tab", false),
  app("tab.prev", "Previous tab", "Tabs and panes", "Ctrl+Shift+Tab", false),
  app("view.split", "Open the note side by side", "Tabs and panes", "Mod+\\"),
  app("view.mode", "Switch between Reading and editing", "Tabs and panes", "Mod+E"),
  app("file.save", "Save the file", "Tabs and panes", "Mod+S", false),
  app("zoom.in", "Zoom in", "Window", "Mod+="),
  app("zoom.out", "Zoom out", "Window", "Mod+-"),
  app("zoom.reset", "Reset zoom", "Window", "Mod+0"),
  { id: "global.capture", label: "Quick capture window", group: "Window", default: "Mod+Alt+M", mac: "Mod+Alt+Shift+M", scope: "global", remappable: false },
  editor("editor.bold", "Bold", "Mod+B"),
  editor("editor.italic", "Italic", "Mod+I"),
  editor("editor.comment", "Toggle comment", "Mod+/"),
  editor("editor.select-next", "Select the next occurrence", "Mod+D"),
  editor("editor.select-matches", "Select every occurrence", "Mod+Shift+L"),
  editor("editor.macro-record", "Macro: record or stop", "Mod+Shift+R"),
  editor("editor.macro-play", "Macro: play the last one", "Mod+Shift+P"),
  editor("editor.column-up", "Rectangular selection up", "Alt+Shift+ArrowUp"),
  editor("editor.column-down", "Rectangular selection down", "Alt+Shift+ArrowDown"),
  editor("editor.column-left", "Rectangular selection left", "Alt+Shift+ArrowLeft"),
  editor("editor.column-right", "Rectangular selection right", "Alt+Shift+ArrowRight"),
  terminal("terminal.copy", "Copy the selection", "Mod+C"),
  terminal("terminal.paste", "Paste", "Mod+V"),
  terminal("terminal.search", "Search the output", "Mod+Shift+F"),
  terminal("terminal.leave", "Move the focus out of the terminal", "Mod+Shift+K"),
  terminal("terminal.newline", "New line without running", "Shift+Enter"),
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));
export const shortcut = (id: string): Shortcut | undefined => BY_ID.get(id);

/** Combos the app never gives away: the platform's text and reload keys. */
const RESERVED = ["Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Shift+Z", "Mod+Y", "Mod+A", "Mod+F", "Mod+R", "Mod+Shift+R", "Tab", "Shift+Tab", "Escape"];

// Parsing ------------------------------------------------------------------------------------------------------------

export interface Parsed { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string }

const NAMED = ["Tab", "Enter", "Escape", "Space", "Plus", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/** A key as combos spell it: letters in capitals, `Plus` for +, `Space` for a space, names as `KeyboardEvent.key` has them. */
function keyName(key: string): string | null {
  if (key === "+") return "Plus";
  if (key === " ") return "Space";
  if (key.length === 1) return /[\s+]/.test(key) || key.charCodeAt(0) < 32 ? null : key.toUpperCase();
  if (key === "Esc") return "Escape";
  return NAMED.includes(key) || FUNCTION_KEY.test(key) ? key : null;
}

/** Read a combo; null when it is not one this app can use. */
export function parse(combo: string): Parsed | null {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  // A key is spelled as keyName gives it: `Plus` for +, capitals for letters.
  if (key.length === 0 || keyName(key) !== key) return null;
  const parsed: Parsed = { mod: false, ctrl: false, alt: false, shift: false, key };
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part)) return null;
    seen.add(part);
    if (part === "Mod") parsed.mod = true;
    else if (part === "Ctrl") parsed.ctrl = true;
    else if (part === "Alt") parsed.alt = true;
    else if (part === "Shift") parsed.shift = true;
    else return null;
  }
  return parsed;
}

/** The combo in its one spelling, or null when it cannot be read. Windows and Linux have no separate Cmd, so there `Ctrl`
 *  and `Mod` are the same key. */
export function normalize(combo: string): string | null {
  const p = parse(combo);
  if (!p) return null;
  const mod = p.mod || (!isMac && p.ctrl);
  const ctrl = p.ctrl && isMac;
  return [mod && "Mod", ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", p.key].filter(Boolean).join("+");
}

/** A combo only a modifier other than Shift makes safe to bind: a bare letter would take typing. Function keys stand alone. */
export function usable(combo: string): boolean {
  const p = parse(combo);
  return !!p && (p.mod || p.ctrl || p.alt || FUNCTION_KEY.test(p.key));
}

// Matching -----------------------------------------------------------------------------------------------------------

export interface ComboEvent { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** The key of an event as combos spell it. With Option or Alt held a letter or digit is read from the physical key, since
 *  macOS turns Option+M into another character. */
export function eventKey(e: ComboEvent): string | null {
  const code = e.code ?? "";
  if (e.altKey && /^Key[A-Z]$/.test(code)) return code.slice(3);
  if (e.altKey && /^Digit[0-9]$/.test(code)) return code.slice(5);
  return keyName(e.key);
}

function matchesParsed(e: ComboEvent, p: Parsed): boolean {
  if (e.altKey !== p.alt) return false;
  if (isMac) { if (e.metaKey !== p.mod || e.ctrlKey !== p.ctrl) return false; }
  else if ((e.ctrlKey || e.metaKey) !== (p.mod || p.ctrl)) return false;
  // Shift decides the character of = and -: + is Shift+= on most layouts, and _ is Shift+-.
  if (p.key === "=" || p.key === "-") return (e.key === p.key || e.key === (p.key === "=" ? "+" : "_")) && (!p.shift || e.shiftKey);
  return e.shiftKey === p.shift && eventKey(e) === p.key;
}

// What each id is bound to now -----------------------------------------------------------------------------------------

let overrides: Record<string, string> = {};
let version = 0;
const listeners = new Set<() => void>();

/** The combo an id has by default on this platform. */
export const defaultCombo = (id: string): string => { const s = BY_ID.get(id); return s ? (isMac && s.mac ? s.mac : s.default) : ""; };

/** The combo an id has now: the saved one when it is a remappable shortcut and the combo can be used, else the default. */
export function combo(id: string): string {
  const s = BY_ID.get(id);
  const own = s?.remappable ? overrides[id] : undefined;
  return own && usable(own) ? own : defaultCombo(id);
}

/** Whether the key event is the shortcut `id`. The callers keep their own guards (an open dialog, a field that takes text). */
export function matches(e: ComboEvent, id: string): boolean {
  const p = parse(combo(id));
  return !!p && matchesParsed(e, p);
}

/** The first of `ids` the event matches. */
export const firstMatch = <T extends string>(e: ComboEvent, ids: readonly T[]): T | undefined => ids.find((id) => matches(e, id));

const KEY_LABELS: Record<string, string> = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", Plus: "+", PageUp: "Page Up", PageDown: "Page Down" };

/** A combo as the user reads it: `Ctrl+Shift+F`, or `Cmd+Shift+F` and `Option` on macOS. Text that is not a combo comes back as is. */
export function formatCombo(text: string): string {
  const p = parse(text);
  if (!p) return text;
  return [p.mod && modKey(), p.ctrl && "Ctrl", p.alt && (isMac ? "Option" : "Alt"), p.shift && "Shift", KEY_LABELS[p.key] ?? p.key].filter(Boolean).join("+");
}

/** The shortcut `id` as shown in menus, the palette and the sheet, after any change the user made. */
export const format = (id: string): string => formatCombo(combo(id));

/** The combo the key event makes, to record it; null while only modifiers are down or for a key combos cannot name. */
export function comboOf(e: ComboEvent): string | null {
  const key = eventKey(e);
  if (!key || ["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey || e.metaKey;
  return [mod && "Mod", isMac && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** Tauri's accelerator text (`CommandOrControl+Alt+M`) as a combo, for the quick-capture hotkey; the text itself when unknown. */
export function fromAccelerator(accelerator: string): string {
  const names: Record<string, string> = { commandorcontrol: "Mod", cmdorctrl: "Mod", command: "Mod", cmd: "Mod", super: "Mod", control: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" };
  const parts = accelerator.split("+").map((p) => names[p.toLowerCase()] ?? p);
  const text = parts.join("+");
  return parse(text) ? text : accelerator;
}

// Conflicts ----------------------------------------------------------------------------------------------------------

export interface Conflict {
  /** `reserved` and `app` refuse the combo; `editor` and `terminal` only warn. */
  kind: "reserved" | "app" | "editor" | "terminal";
  /** What already uses it: a label, or the combo for a reserved one. */
  with: string;
  refuse: boolean;
}

/** What `candidate` would clash with if `id` took it: the reserved keys and the other app shortcuts refuse it, an editor or
 *  terminal key only warns, since those views take the key first. */
export function conflicts(candidate: string, id: string): Conflict[] {
  const want = normalize(candidate);
  if (!want) return [];
  const found: Conflict[] = [];
  const reserved = RESERVED.find((r) => normalize(r) === want);
  if (reserved || parse(candidate)?.key === "F5") found.push({ kind: "reserved", with: formatCombo(reserved ?? want), refuse: true });
  for (const s of SHORTCUTS) {
    if (s.id === id || s.scope === "global") continue;
    const theirs = normalize(s.scope === "app" ? combo(s.id) : defaultCombo(s.id));
    if (theirs !== want) continue;
    found.push({ kind: s.scope === "app" ? "app" : s.scope, with: s.label, refuse: s.scope === "app" });
  }
  return found;
}

// Following the settings file ---------------------------------------------------------------------------------------

const changed = () => { version++; listeners.forEach((l) => l()); };

/** Use the overrides Rust holds (an id to combo map). */
export function setOverrides(next: Record<string, string>): void {
  overrides = { ...next };
  changed();
}

export const currentOverrides = (): Record<string, string> => overrides;
export const overrideCount = (): number => Object.keys(overrides).length;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** Re-draw when any shortcut changes, for a view that shows several. */
export const useShortcutVersion = (): number => useSyncExternalStore(subscribe, () => version);
/** The shortcut `id` as text, kept current. */
export const useFormat = (id: string): string => useSyncExternalStore(subscribe, () => format(id));

/** Read the overrides and follow every change, in this window and the others. Called once, in each window. Returns the undo. */
export function initShortcuts(): () => void {
  if (!inTauri()) return () => {};
  let stopped = false;
  const unlisten = listen<Record<string, string>>("shortcuts", (e) => { if (!stopped) setOverrides(e.payload); });
  // The read waits for the subscription, so a change between the two is heard, not missed.
  const read = () => invoke<Record<string, string>>("shortcuts_get").then((all) => { if (!stopped) setOverrides(all); }, () => undefined);
  void unlisten.then(read, read);
  return () => { stopped = true; void unlisten.then((u) => u(), () => undefined); };
}

/** Keep `value` for `id` (null goes back to the default). Rust checks it and tells every window; rejects with its reason. */
export async function saveShortcut(id: string, value: string | null): Promise<void> {
  if (!inTauri()) { const next = { ...overrides }; if (value) next[id] = value; else delete next[id]; setOverrides(next); return; }
  setOverrides(await invoke<Record<string, string>>("shortcuts_set", { id, combo: value }));
}

/** Go back to every default. */
export async function resetShortcuts(): Promise<void> {
  if (!inTauri()) { setOverrides({}); return; }
  setOverrides(await invoke<Record<string, string>>("shortcuts_reset"));
}
