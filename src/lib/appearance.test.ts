// @vitest-environment jsdom
// Appearance settings in the settings file (DESK-11): the file wins over the localStorage copy, a copy the file lacks is sent
// once, and a change in any window reaches the others through the `appearance` event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as ((e: { payload: unknown }) => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: (e: { payload: unknown }) => void) => { mocks.listeners.push(cb); return () => undefined; },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => undefined }) }));

const { initDefaultMode, setDefaultMode } = await import("./appearance");
const { applyDocSize, initDocSize } = await import("./docSize");
const { applyPaperDefault, initPaperDefault, paperDefault } = await import("./paper");
const { prefs } = await import("./prefs");
const { applyTheme, currentThemeChoice, initTheme } = await import("./theme");

const none = { theme: null, document_background: null, document_size: null, default_mode: null };
const flush = () => new Promise((r) => setTimeout(r, 0));
const sent = () => mocks.invoke.mock.calls.filter((c) => c[0] === "appearance_set").map((c) => c[1]);
const emit = (payload: unknown) => mocks.listeners.forEach((l) => l({ payload }));
const startAll = async () => { initTheme(); initPaperDefault(); initDocSize(); initDefaultMode(); await flush(); };
const docSizeVar = () => document.documentElement.style.getPropertyValue("--doc-size");

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  mocks.listeners.length = 0;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "appearance_get" ? none : undefined));
  applyTheme("purple", false); applyPaperDefault("theme", false); applyDocSize(1, false);
});
afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__; });

describe("start", () => {
  it("sends a value only the localStorage copy has to the settings file, once", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    localStorage.setItem("hivemind.documentBackground", "white");
    localStorage.setItem("hivemind.documentSize", "1.25");
    localStorage.setItem("hivemind.defaultMode", "live");
    await startAll();
    expect(sent()).toEqual([
      { key: "theme", value: "emerald" }, { key: "document_background", value: "white" },
      { key: "document_size", value: 1.25 }, { key: "default_mode", value: "live" },
    ]);
  });

  it("sends nothing for a value that was never set anywhere", async () => {
    await startAll();
    expect(sent()).toEqual([]);
  });

  it("applies the settings file's values and refreshes the copy when they differ", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === "appearance_get"
      ? { theme: "emerald-light", document_background: "white", document_size: 1.5, default_mode: "source" } : undefined));
    await startAll();
    expect(currentThemeChoice()).toBe("emerald-light");
    expect(document.documentElement.dataset.theme).toBe("emerald-light");
    expect(paperDefault()).toBe("white");
    expect(docSizeVar()).toBe("1.5");
    expect([prefs.theme(), prefs.paper(), prefs.docSize(), prefs.defaultMode()]).toEqual(["emerald-light", "white", 1.5, "source"]);
    expect(sent()).toEqual([]);
  });

  it("does not undo a change made or heard while the start-up read was on its way", async () => {
    const answers: ((v: unknown) => void)[] = [];
    mocks.invoke.mockImplementation((cmd: string) => (cmd === "appearance_get"
      ? new Promise((r) => { answers.push(r); }) : Promise.resolve(undefined)));
    initTheme(); initPaperDefault();
    await flush();
    const stale = { ...none, theme: "purple", document_background: "theme" };
    applyTheme("emerald");
    answers[0](stale);   // the theme's read, after a save in this window
    await flush();
    emit({ ...none, document_background: "white" });
    answers[1](stale);   // the background's read, after an event from another window
    await flush();
    expect(currentThemeChoice()).toBe("emerald");
    expect(paperDefault()).toBe("white");
  });
});

describe("a change in any window", () => {
  it("is applied and copied here when the appearance event arrives, without being sent back", async () => {
    await startAll();
    emit({ theme: "emerald", document_background: "white", document_size: 1.1, default_mode: "live" });
    expect(currentThemeChoice()).toBe("emerald");
    expect(paperDefault()).toBe("white");
    expect(docSizeVar()).toBe("1.1");
    expect([prefs.theme(), prefs.paper(), prefs.docSize(), prefs.defaultMode()]).toEqual(["emerald", "white", 1.1, "live"]);
    expect(sent()).toEqual([]);
  });

  it("leaves a setting alone when the event has no value for it", async () => {
    await startAll();
    emit({ ...none, theme: "emerald-light" });
    expect(currentThemeChoice()).toBe("emerald-light");
    expect(paperDefault()).toBe("theme");
    expect(docSizeVar()).toBe("1");
  });

  it("is sent to the settings file by the setters, and applying a value that came from there sends nothing", () => {
    applyTheme("system");
    applyPaperDefault("white");
    applyDocSize(1.25);
    setDefaultMode("source");
    expect(sent()).toEqual([
      { key: "theme", value: "system" }, { key: "document_background", value: "white" },
      { key: "document_size", value: 1.25 }, { key: "default_mode", value: "source" },
    ]);
    expect([prefs.theme(), prefs.paper(), prefs.docSize(), prefs.defaultMode()]).toEqual(["system", "white", 1.25, "source"]);
    mocks.invoke.mockClear();
    applyTheme("emerald", false);
    applyPaperDefault("theme", false);
    applyDocSize(1, false);
    expect(sent()).toEqual([]);
  });
});
