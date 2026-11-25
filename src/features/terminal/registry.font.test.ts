// @vitest-environment jsdom
// A new code font (DESK-TYPE, review C1): a terminal that is not in the page keeps its old font until it is shown again, then
// takes the new font before it fits, so the grid and the PTY are sized for the font it draws with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => ({
  terms: [] as { options: { fontFamily: string }; element?: HTMLElement }[],
  fits: [] as { id: number; fontFamily: string }[],
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { fontFamily: string };
    element?: HTMLElement;
    unicode = { activeVersion: "" };
    parser = { registerOscHandler: () => undefined };
    constructor(opts: { fontFamily: string }) { this.options = { ...opts }; xterm.terms.push(this); }
    loadAddon(addon: { activate?: (t: unknown) => void }) { addon.activate?.(this); }
    open(el: HTMLElement) { this.element = el; }
    attachCustomKeyEventHandler() {}
    onKey() {} onData() {} onResize() {}
    write() {} focus() {} dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term?: { options: { fontFamily: string } };
    activate(t: { options: { fontFamily: string } }) { this.term = t; }
    fit() { xterm.fits.push({ id: xterm.terms.indexOf(this.term as never), fontFamily: this.term!.options.fontFamily }); }
  },
}));
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
const { applyType } = await import("../../lib/typography");

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const info = { id: "shell-1", sessionId: null, engine: "claude" as const, running: true, exitCode: null, windowsBuild: null, label: null, cwd: null, attention: null };

beforeEach(() => {
  xterm.terms.length = 0; xterm.fits.length = 0;
  // jsdom has no layout: an element counts as shown when it is in the page.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return (this as HTMLElement).isConnected ? document.body : null; } });
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  applyType("mono_font", "jetbrains", false);
});
afterEach(() => { registry.dispose("shell-1"); document.body.innerHTML = ""; });

async function mounted() {
  registry.ensure("shell-1", { sessionId: null, engine: null, start: null, shell: true, adopt: { info, output: { onmessage: undefined } as never, early: [] } });
  await flush();
  const host = document.createElement("div");
  document.body.append(host);
  registry.mount("shell-1", host, { focus: false });
  return host;
}

describe("a terminal and a new code font", () => {
  it("takes the font at once and fits when it is in the page", async () => {
    await mounted();
    xterm.fits.length = 0;
    applyType("mono_font", "consolas", false);
    expect(xterm.terms[0].options.fontFamily).toMatch(/^Consolas/);
    expect(xterm.fits[xterm.fits.length - 1]?.fontFamily).toMatch(/^Consolas/);
  });

  it("keeps the old font while detached, then takes it before fitting when shown again", async () => {
    const host = await mounted();
    host.replaceChildren();   // the pane was closed: the terminal's element is out of the page
    xterm.fits.length = 0;
    applyType("mono_font", "cascadia", false);
    expect(xterm.terms[0].options.fontFamily).toMatch(/^"JetBrains Mono Variable"/);
    expect(xterm.fits).toEqual([]);
    const again = document.createElement("div");
    document.body.append(again);
    registry.mount("shell-1", again, { focus: false });
    expect(xterm.terms[0].options.fontFamily).toMatch(/^"Cascadia Code"/);
    expect(xterm.fits.map((f) => f.fontFamily)).toEqual([xterm.terms[0].options.fontFamily]);
  });

  it("does not fit again when another setting changes and the code font stays", async () => {   // Codex re-review of 2abc495
    await mounted();
    applyType("mono_font", "consolas", false);
    xterm.fits.length = 0;
    applyType("density", "compact", false);
    applyType("mono_font", "consolas", false);
    expect(xterm.fits).toEqual([]);
    applyType("density", "comfortable", false);
  });
});
