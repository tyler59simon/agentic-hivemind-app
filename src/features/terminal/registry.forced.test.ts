// @vitest-environment jsdom
// DESKA4-XTERM: in a Windows contrast theme the terminal takes the system colours and a minimum contrast for the ANSI colours, and
// every open terminal is recoloured when the theme is turned on or off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Options = { theme?: { background?: string; foreground?: string; cursor?: string; selectionBackground?: string }; minimumContrastRatio?: number; fontFamily?: string };
const xterm = vi.hoisted(() => ({ terms: [] as { options: Options }[] }));
// The contrast theme's switch, as `matchMedia("(forced-colors: active)")` sees it.
const media = vi.hoisted(() => {
  const state = { matches: false, listeners: new Set<() => void>(), queries: [] as string[] };
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => {
    state.queries.push(query);
    return {
      get matches() { return state.matches; },
      addEventListener: (_: string, l: () => void) => state.listeners.add(l),
      removeEventListener: (_: string, l: () => void) => state.listeners.delete(l),
    };
  };
  return state;
});
const turn = (on: boolean) => { media.matches = on; media.listeners.forEach((l) => l()); };

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Options;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: () => undefined };
    constructor(opts: Options) { this.options = { ...opts }; xterm.terms.push(this); }
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open() {} attachCustomKeyEventHandler() {} onKey() {} onData() {} onResize() {} write() {} focus() {} dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage?: unknown }, invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/term", () => ({ termClose: vi.fn(), termLogin: vi.fn(), termOpen: vi.fn(), termResize: vi.fn(async () => undefined), termShell: vi.fn(), termWrite: vi.fn() }));
vi.mock("../notes/drops", () => ({ setTerminalDrops: vi.fn() }));
// jsdom resolves no system colours, so the palette is a fixed one (a dark contrast theme).
const PALETTE = { canvas: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)", highlight: "rgb(26, 235, 255)", highlightText: "rgb(0, 0, 0)", gray: "rgb(63, 242, 63)" };
vi.mock("../../lib/forcedColors", async (original) => ({ ...(await original<object>()), systemPalette: () => PALETTE }));

const registry = await import("./registry");
const { applyTheme } = await import("../../lib/theme");

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const info = { id: "shell-1", sessionId: null, engine: "claude" as const, running: true, exitCode: null, windowsBuild: null, label: null, cwd: null, attention: null };
const open = async (id: string) => {
  registry.ensure(id, { sessionId: null, engine: null, start: null, shell: true, adopt: { info: { ...info, id }, output: { onmessage: undefined } as never, early: [] } });
  await flush();
};

beforeEach(() => {
  xterm.terms.length = 0; media.matches = false;
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
});
afterEach(() => { registry.dispose("shell-1"); registry.dispose("shell-2"); document.body.innerHTML = ""; });

describe("a terminal and a Windows contrast theme", () => {
  it("watches the forced-colors query, and starts with the app's colours and no contrast adjustment while it is off", async () => {
    expect(media.queries).toContain("(forced-colors: active)");
    await open("shell-1");
    const o = xterm.terms[0].options;
    expect(o.minimumContrastRatio).toBe(1);
    expect(o.theme!.background).not.toBe(PALETTE.canvas);
  });

  it("starts with the system colours when the contrast theme is already on", async () => {
    media.matches = true;
    await open("shell-1");
    const o = xterm.terms[0].options;
    expect([o.theme!.background, o.theme!.foreground, o.theme!.cursor, o.theme!.selectionBackground]).toEqual([PALETTE.canvas, PALETTE.text, PALETTE.highlight, PALETTE.highlight]);
    expect(o.minimumContrastRatio).toBe(7);
  });

  it("recolours every open terminal when the contrast theme is turned on, and back when it is turned off", async () => {
    await open("shell-1");
    await open("shell-2");
    const before = xterm.terms.map((t) => t.options.theme);
    turn(true);
    for (const t of xterm.terms) {
      expect([t.options.theme!.background, t.options.theme!.foreground]).toEqual([PALETTE.canvas, PALETTE.text]);
      expect(t.options.minimumContrastRatio).toBe(7);
    }
    turn(false);
    xterm.terms.forEach((t, i) => {
      expect(t.options.theme).toEqual(before[i]);
      expect(t.options.minimumContrastRatio).toBe(1);
    });
  });

  it("keeps the system colours when the app's own theme changes while the contrast theme is on", async () => {
    await open("shell-1");
    turn(true);
    applyTheme("emerald", false);
    expect(xterm.terms[0].options.theme!.background).toBe(PALETTE.canvas);
    turn(false);
    expect(xterm.terms[0].options.theme!.background).not.toBe(PALETTE.canvas);
  });
});
