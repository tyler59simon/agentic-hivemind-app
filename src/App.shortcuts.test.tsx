// @vitest-environment jsdom
// The app-wide keys (DESK-KEYS): each default combo still does what it did, a dialog in front stops them, and a remap in
// Settings moves them. Ctrl+/ opens the reference sheet, except in an editor or a terminal.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./features/graph/GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "capture_status" ? { shortcut: "CommandOrControl+Alt+M", error: null, close_to_tray: true } : null)) }));

const { useShortcuts } = await import("./App");
const { ShortcutsDialog, useShortcutsDialog } = await import("./features/shortcuts/ShortcutsDialog");
const { useApp } = await import("./store");
const { useWorkspace } = await import("./workspace/store");
const { setOverrides } = await import("./lib/shortcuts");
const { pushLayer } = await import("./ui/layers");
const { setMacForTests } = await import("./lib/platform");
const { CodeEditor } = await import("./features/editor/CodeEditor");

// jsdom has no layout, which CodeMirror reads when it scrolls a selection into view.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

function Host() {
  useShortcuts();
  return <><ShortcutsDialog /><div className="cm-editor"><textarea id="in-editor" /></div></>;
}

let root: Root | null = null;
const press = (key: string, mods: Partial<KeyboardEventInit> = {}, target: EventTarget = window) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  act(() => { target.dispatchEvent(e); });
  return e;
};
const reset = () => {
  useApp.setState({ palette: null, route: { page: "home" }, back: [] });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {} });
  useShortcutsDialog.getState().hide();
};

beforeEach(async () => {
  reset();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setOverrides({});
  setMacForTests(false);
  reset();
  document.body.innerHTML = "";
});

describe("the default keys", () => {
  it("Ctrl+P opens the command palette and Ctrl+O the note palette", () => {
    expect(press("p", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(useApp.getState().palette).toBe("commands");
    press("o", { ctrlKey: true });
    expect(useApp.getState().palette).toBe("notes");
  });

  it("Ctrl+G opens the graph, Ctrl+N a new note, Alt+Left goes back", () => {
    useApp.getState().go({ page: "inbox" });
    press("g", { ctrlKey: true });
    expect(useApp.getState().route).toEqual({ page: "notes", view: "graph" });
    press("ArrowLeft", { altKey: true });
    expect(useApp.getState().route.page).toBe("inbox");
    useApp.getState().go({ page: "agents" });
    press("n", { ctrlKey: true });
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.kind)).toEqual(["new-note"]);
  });

  it("Ctrl+W is swallowed so the window never closes", () => {
    expect(press("w", { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it("does nothing with another modifier on top, or without one", () => {
    press("p", { ctrlKey: true, shiftKey: true });
    press("p", { ctrlKey: true, altKey: true });
    press("p");
    expect(useApp.getState().palette).toBeNull();
  });

  it("does nothing while a dialog is open", () => {
    const layer = pushLayer(() => {}, undefined, true);
    press("p", { ctrlKey: true });
    press("/", { ctrlKey: true });
    expect(useApp.getState().palette).toBeNull();
    expect(useShortcutsDialog.getState().open).toBe(false);
    layer.pop();
  });

  it("uses Cmd and not Ctrl on macOS, and keeps Alt+Left for text there", () => {
    setMacForTests(true);
    press("p", { ctrlKey: true });
    expect(useApp.getState().palette).toBeNull();
    press("p", { metaKey: true });
    expect(useApp.getState().palette).toBe("commands");
    useApp.getState().go({ page: "inbox" });
    useApp.getState().go({ page: "agents" });
    press("ArrowLeft", { altKey: true }, document.getElementById("in-editor")!);
    expect(useApp.getState().route.page).toBe("agents");
    press("ArrowLeft", { altKey: true });
    expect(useApp.getState().route.page).toBe("inbox");
  });
});

describe("Ctrl+/", () => {
  it("opens the reference sheet", async () => {
    press("/", { ctrlKey: true });
    expect(document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')).not.toBeNull();
  });

  it("leaves the key to an editor, which toggles a comment with it", () => {
    const e = press("/", { ctrlKey: true }, document.getElementById("in-editor")!);
    expect(e.defaultPrevented).toBe(false);
    expect(useShortcutsDialog.getState().open).toBe(false);
  });
});

describe("Ctrl+/ in a real editor (CodeMirror)", () => {
  let holder: HTMLElement;
  let editorRoot: Root;
  const content = () => holder.querySelector<HTMLElement>(".cm-content")!;
  const typed = () => content().textContent;
  const send = async (k: string, mods: Partial<KeyboardEventInit> = {}) => {
    const e = new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true, ...mods });
    await act(async () => { content().dispatchEvent(e); });
    return e;
  };
  beforeEach(async () => {
    holder = document.createElement("div");
    document.body.append(holder);
    editorRoot = createRoot(holder);
    await act(async () => editorRoot.render(<CodeEditor doc="hello" docVersion={0} language="markdown" live={false} readOnly={false} lineNumbers
      onChange={() => {}} onSave={() => {}} titles={() => []} onOpenLink={() => {}} />));
    content().focus();
  });
  afterEach(async () => { await act(async () => editorRoot.unmount()); holder.remove(); });

  it("the editor toggles its comment and the sheet stays closed", async () => {
    const e = await send("/", { ctrlKey: true });
    expect(typed()).toContain("<!--");
    expect(e.defaultPrevented).toBe(true);
    expect(useShortcutsDialog.getState().open).toBe(false);
  });

  it("a sheet key that is no longer the editor's comment key opens the sheet inside the editor", async () => {
    setOverrides({ "shortcuts.show": "Mod+Alt+K" });
    await send("/", { ctrlKey: true });
    expect(useShortcutsDialog.getState().open).toBe(false); // the editor toggled its comment
    await send("k", { ctrlKey: true, altKey: true });
    expect(useShortcutsDialog.getState().open).toBe(true);
  });
});

describe("a remapped key", () => {
  it("moves the shortcut: the new combo works and the old one does not", () => {
    setOverrides({ "palette.commands": "Mod+J", "shortcuts.show": "Alt+K" });
    press("p", { ctrlKey: true });
    expect(useApp.getState().palette).toBeNull();
    press("j", { ctrlKey: true });
    expect(useApp.getState().palette).toBe("commands");
    press("/", { ctrlKey: true });
    expect(useShortcutsDialog.getState().open).toBe(false);
    press("k", { altKey: true });
    expect(useShortcutsDialog.getState().open).toBe(true);
  });
});
