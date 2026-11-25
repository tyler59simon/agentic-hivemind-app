// @vitest-environment jsdom
// The terminal's way out (DESK-LAYOUT, review A1): Ctrl+Shift+K moves the focus from a terminal to the search box, and in focus
// mode, where the top bar is hidden, to the button that leaves focus mode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => ({ handlers: [] as ((e: KeyboardEvent) => boolean)[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    element?: HTMLElement;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: () => undefined };
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open(el: HTMLElement) { this.element = el; }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) { xterm.handlers.push(fn); }
    hasSelection() { return false; }
    onKey() {} onData() {} onResize() {}
    write() {} focus() {} dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage?: unknown }, invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/term", () => ({ termClose: vi.fn(), termLogin: vi.fn(), termOpen: vi.fn(), termResize: vi.fn(async () => undefined), termShell: vi.fn(), termWrite: vi.fn() }));
vi.mock("../notes/drops", () => ({ setTerminalDrops: vi.fn() }));

const registry = await import("./registry");

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const info = { id: "shell-1", sessionId: null, engine: "claude" as const, running: true, exitCode: null, windowsBuild: null, label: null, cwd: null, attention: null };
const leave = () => new KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

beforeEach(async () => {
  xterm.handlers.length = 0;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return (this as HTMLElement).isConnected ? document.body : null; } });
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  registry.ensure("shell-1", { sessionId: null, engine: null, start: null, shell: true, adopt: { info, output: { onmessage: undefined } as never, early: [] } });
  await flush();
  const host = document.createElement("div");
  document.body.append(host);
  registry.mount("shell-1", host, { focus: false });
  await flush();
});
afterEach(() => { registry.dispose("shell-1"); document.body.innerHTML = ""; });

describe("Ctrl+Shift+K in a terminal", () => {
  it("focuses the search box in the top bar", () => {
    document.body.insertAdjacentHTML("beforeend", '<div class="top-search"><input aria-label="Search" /></div><button class="focus-exit">Exit focus mode</button>');
    // The button is only drawn in focus mode; without it the search box is the way out.
    document.querySelector(".focus-exit")!.remove();
    expect(xterm.handlers).toHaveLength(1);
    expect(xterm.handlers[0](leave())).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".top-search input"));
  });

  it("focuses the button that leaves focus mode when the top bar is hidden", () => {
    document.body.insertAdjacentHTML("beforeend", '<div class="top-search"><input aria-label="Search" /></div><button class="focus-exit">Exit focus mode</button>');
    expect(xterm.handlers[0](leave())).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".focus-exit"));
  });
});
