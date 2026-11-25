// @vitest-environment jsdom
// Appearance settings in the settings file (DESK-11), against a small stateful fake of the Rust side: one settings file,
// named events to every registered listener, and windows that are separate module instances sharing one localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const KNOWN: Record<string, unknown[]> = {
    theme: ["purple", "emerald", "emerald-light", "system"], document_background: ["theme", "white"],
    document_size: [0.9, 1, 1.1, 1.25, 1.5], default_mode: ["reading", "live", "source"], spellcheck: [true, false],
  };
  type Listener = { name: string; cb: (e: { payload: unknown }) => void };
  const f = {
    file: {} as Record<string, unknown>,   // the settings file: a missing key is unset
    listeners: [] as Listener[],
    writes: [] as { cmd: string; key: string; value: unknown }[],   // changes that reached the file
    calls: [] as string[],
    holds: new Map<string, Promise<void>>(),
    gate: Promise.resolve(),
    failSets: false,
    snapshot: () => Object.fromEntries(Object.keys(KNOWN).map((k) => [k, f.file[k] ?? null])),
    emit: () => {
      const payload = f.snapshot();
      for (const l of f.listeners) if (l.name === "appearance") queueMicrotask(() => l.cb({ payload }));
    },
    /** A change from somewhere else (another window): the file changes and the registered listeners hear it. */
    externalSet: (values: Record<string, unknown>) => { Object.assign(f.file, values); f.emit(); },
    /** Make the next `appearance_get` answer, or the first write ("write": a set or an init), wait until the returned function runs. */
    hold: (cmd: string) => {
      let release!: () => void;
      f.holds.set(cmd, new Promise<void>((r) => { release = r; }));
      return () => { f.holds.delete(cmd); release(); };
    },
    /** Make `listen` wait to register until the returned function runs. */
    holdListen: () => {
      let release!: () => void;
      f.gate = new Promise<void>((r) => { release = r; });
      return release;
    },
    invoke: async (cmd: string, args?: { key: string; value: unknown }) => {
      f.calls.push(cmd);
      if (cmd === "appearance_get") { const answer = f.snapshot(); await f.holds.get(cmd); return answer; }
      if (cmd !== "appearance_set" && cmd !== "appearance_init") return undefined;
      const held = f.holds.get("write");
      f.holds.delete("write");   // only the first write waits
      await held;
      if (cmd === "appearance_set" && f.failSets) throw "disk full";
      const { key, value } = args!;
      if (!(key in KNOWN) || !KNOWN[key].includes(value)) throw `not a known ${key}`;
      if (cmd === "appearance_init" && f.file[key] != null) return false;
      f.file[key] = value;
      f.writes.push({ cmd, key, value });
      f.emit();
      return true;
    },
    listen: async (name: string, cb: Listener["cb"]) => {
      await f.gate;
      const entry = { name, cb };
      f.listeners.push(entry);
      return () => { f.listeners.splice(f.listeners.indexOf(entry), 1); };
    },
    reset: () => {
      f.file = {}; f.listeners.length = 0; f.writes.length = 0; f.calls.length = 0; f.holds.clear();
      f.gate = Promise.resolve(); f.failSets = false;
    },
  };
  return f;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: async () => undefined }) }));

/** A new window: its own copy of every module, as the main and the capture window each have, with the same localStorage. */
async function openWindow() {
  vi.resetModules();
  const [appearance, theme, paper, docSize, spell, prefs, toast] = await Promise.all([
    import("./appearance"), import("./theme"), import("./paper"), import("./docSize"), import("./spellcheck"), import("./prefs"), import("../ui/toast"),
  ]);
  return { appearance, theme, paper, docSize, spell, prefs, toasts: () => toast.useToasts.getState().items };
}
type Win = Awaited<ReturnType<typeof openWindow>>;

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const start = (w: Win) => { w.theme.initTheme(); w.paper.initPaperDefault(); w.docSize.initDocSize(); w.appearance.initDefaultMode(); w.spell.initSpellcheck(); };
const startAndWait = async (w: Win) => { start(w); await flush(); };
const state = (w: Win) => [w.theme.currentThemeChoice(), w.paper.paperDefault()];
const docSizeVar = () => document.documentElement.style.getPropertyValue("--doc-size");

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  fake.reset();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("--doc-size");
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("start", () => {
  it("moves a value only the localStorage copy has into the settings file", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    localStorage.setItem("hivemind.documentBackground", "white");
    localStorage.setItem("hivemind.documentSize", "1.25");
    localStorage.setItem("hivemind.defaultMode", "live");
    await startAndWait(await openWindow());
    expect(fake.file).toEqual({ theme: "emerald", document_background: "white", document_size: 1.25, default_mode: "live" });
    expect(fake.writes.map((w) => w.cmd)).toEqual(Array(4).fill("appearance_init"));
  });

  it("sends nothing for a value that was never set anywhere", async () => {
    await startAndWait(await openWindow());
    expect(fake.writes).toEqual([]);
  });

  it("applies the settings file's values and refreshes the copy when they differ", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    fake.file = { theme: "emerald-light", document_background: "white", document_size: 1.5, default_mode: "source" };
    const w = await openWindow();
    await startAndWait(w);
    expect(w.theme.currentThemeChoice()).toBe("emerald-light");
    expect(document.documentElement.dataset.theme).toBe("emerald-light");
    expect(w.paper.paperDefault()).toBe("white");
    expect(docSizeVar()).toBe("1.5");
    expect([w.prefs.prefs.theme(), w.prefs.prefs.paper(), w.prefs.prefs.docSize(), w.prefs.prefs.defaultMode()]).toEqual(["emerald-light", "white", 1.5, "source"]);
    expect(fake.writes).toEqual([]);
  });

  it("moves a copy once across two windows and a restart (C3)", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    const [main, capture] = [await openWindow(), await openWindow()];
    start(main); start(capture);
    await flush();
    expect(fake.calls.filter((c) => c === "appearance_init")).toHaveLength(2);
    expect(fake.writes).toEqual([{ cmd: "appearance_init", key: "theme", value: "emerald" }]);
    expect([state(main)[0], state(capture)[0]]).toEqual(["emerald", "emerald"]);
    fake.listeners.length = 0;   // the app quits and starts again
    await startAndWait(await openWindow());
    expect(fake.writes).toHaveLength(1);
  });

  it("does not let a late move of the copy replace a choice made since (C3)", async () => {
    localStorage.setItem("hivemind.theme", "emerald");
    const release = fake.hold("write");
    const main = await openWindow();
    const other = await openWindow();   // never started: it only makes the choice
    await startAndWait(main);           // reads an empty file; its move is still on its way
    other.theme.applyTheme("purple");
    await flush();
    release();
    await flush();
    expect(fake.file.theme).toBe("purple");
    expect(main.theme.currentThemeChoice()).toBe("purple");
  });

  it("does not drop a key's move because the event of another key arrived (C1)", async () => {
    localStorage.setItem("hivemind.documentBackground", "white");
    const release = fake.hold("appearance_get");
    const w = await openWindow();
    start(w);
    await flush();   // subscribed, read sent and waiting
    fake.externalSet({ theme: "emerald" });
    await flush();
    release();
    await flush();
    expect(fake.file).toEqual({ theme: "emerald", document_background: "white" });
    expect(w.theme.currentThemeChoice()).toBe("emerald");
  });

  it("hears a change made between the read and the subscription (C2)", async () => {
    const release = fake.holdListen();
    const w = await openWindow();
    start(w);
    await flush();   // the subscription is not registered yet
    fake.externalSet({ theme: "emerald" });
    release();
    await flush();
    expect(w.theme.currentThemeChoice()).toBe("emerald");
  });

  it("does not undo a change made or heard while the start-up read was on its way", async () => {
    const release = fake.hold("appearance_get");
    const w = await openWindow();
    start(w);
    await flush();
    w.theme.applyTheme("emerald");
    fake.externalSet({ document_background: "white" });
    await flush();
    release();
    await flush();
    expect(state(w)).toEqual(["emerald", "white"]);
  });
});

describe("a change in any window", () => {
  it("is applied and copied here when the appearance event arrives, without being sent back", async () => {
    const w = await openWindow();
    await startAndWait(w);
    fake.externalSet({ theme: "emerald", document_background: "white", document_size: 1.1, default_mode: "live" });
    await flush();
    expect(state(w)).toEqual(["emerald", "white"]);
    expect(docSizeVar()).toBe("1.1");
    expect([w.prefs.prefs.theme(), w.prefs.prefs.paper(), w.prefs.prefs.docSize(), w.prefs.prefs.defaultMode()]).toEqual(["emerald", "white", 1.1, "live"]);
    expect(fake.writes).toEqual([]);
  });

  it("leaves a setting alone when the event has no value for it", async () => {
    const w = await openWindow();
    await startAndWait(w);
    fake.externalSet({ theme: "emerald-light" });
    await flush();
    expect(state(w)).toEqual(["emerald-light", "theme"]);
    expect(docSizeVar()).toBe("1");
  });

  it("reaches the other window from a setter, and applying a value that came from the file sends nothing", async () => {
    const [main, capture] = [await openWindow(), await openWindow()];
    await startAndWait(capture);
    main.theme.applyTheme("system");
    main.paper.applyPaperDefault("white");
    main.docSize.applyDocSize(1.25);
    main.appearance.setDefaultMode("source");
    await flush();
    expect(fake.file).toEqual({ theme: "system", document_background: "white", document_size: 1.25, default_mode: "source" });
    expect(state(capture)).toEqual(["system", "white"]);
    expect(capture.appearance.defaultMode()).toBe("source");
    fake.calls.length = 0;
    main.theme.applyTheme("emerald", false);
    main.paper.applyPaperDefault("theme", false);
    main.docSize.applyDocSize(1, false);
    await flush();
    expect(fake.calls).toEqual([]);
  });
});

describe("a change the file refuses (C5)", () => {
  it("shows what the file holds and says so", async () => {
    fake.file = { theme: "emerald-light" };
    const w = await openWindow();
    await startAndWait(w);
    fake.failSets = true;
    w.theme.applyTheme("emerald");
    await flush();
    expect(w.theme.currentThemeChoice()).toBe("emerald-light");
    expect(w.prefs.prefs.theme()).toBe("emerald-light");
    expect(w.toasts().map((t) => [t.kind, t.text])).toEqual([["error", "Could not save the theme setting."]]);
  });

  it("drops a refused first value from the copy, so the next start does not move it into the file", async () => {   // Codex re-review of 2e736f0
    const w = await openWindow();
    await startAndWait(w);
    fake.failSets = true;
    w.theme.applyTheme("emerald");
    await flush();
    expect(localStorage.getItem("hivemind.theme")).toBeNull();
    fake.failSets = false;
    await startAndWait(await openWindow());
    expect(fake.file.theme).toBeUndefined();
  });

  it("shows the default, not the refused value, when the file holds nothing (Codex review of 9f7b80c, C1)", async () => {
    const w = await openWindow();
    await startAndWait(w);
    fake.failSets = true;
    w.spell.setSpellcheck(false);
    w.theme.applyTheme("emerald");
    w.docSize.applyDocSize(1.5);
    w.appearance.setDefaultMode("source");
    await flush();
    expect(w.spell.spellcheck()).toBe(true);
    expect(w.theme.currentThemeChoice()).toBe("purple");
    expect(docSizeVar()).toBe("1");
    expect(w.appearance.defaultMode()).toBe("reading");
    expect(["hivemind.spellcheck", "hivemind.theme", "hivemind.documentSize", "hivemind.defaultMode"].map((k) => localStorage.getItem(k))).toEqual([null, null, null, null]);
    expect(w.toasts()).toHaveLength(4);
  });

  it("lets a newer change win over the read that follows a refused save", async () => {   // Codex re-review of 2e736f0
    fake.file = { theme: "emerald-light" };
    const w = await openWindow();
    await startAndWait(w);
    const release = fake.hold("appearance_get");
    fake.failSets = true;
    w.theme.applyTheme("emerald");      // refused; the read of the file is held
    await flush();
    fake.failSets = false;
    w.theme.applyTheme("system");       // kept, and heard back
    await flush();
    release();
    await flush();
    expect(w.theme.currentThemeChoice()).toBe("system");
    expect(fake.file.theme).toBe("system");
  });
});

describe("the default note mode when localStorage cannot be used (C7)", () => {
  it("follows the settings file and the Settings choice from memory", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    fake.file = { default_mode: "source" };
    const w = await openWindow();
    await startAndWait(w);
    expect(w.appearance.defaultMode()).toBe("source");
    w.appearance.setDefaultMode("live");
    expect(w.appearance.defaultMode()).toBe("live");
  });
});

describe("the spelling check (DESK-8)", () => {
  it("is on when nothing sets it, and sends nothing", async () => {
    const w = await openWindow();
    await startAndWait(w);
    expect(w.spell.spellcheck()).toBe(true);
    expect(fake.writes).toEqual([]);
  });

  it("moves a choice only the localStorage copy has into the settings file, an off one too", async () => {
    localStorage.setItem("hivemind.spellcheck", "0");
    const w = await openWindow();
    await startAndWait(w);
    expect(fake.file).toEqual({ spellcheck: false });
    expect(fake.writes).toEqual([{ cmd: "appearance_init", key: "spellcheck", value: false }]);
    expect(w.spell.spellcheck()).toBe(false);
  });

  it("applies the settings file's value over the copy", async () => {
    localStorage.setItem("hivemind.spellcheck", "0");
    fake.file = { spellcheck: true };
    const w = await openWindow();
    await startAndWait(w);
    expect(w.spell.spellcheck()).toBe(true);
    expect(w.prefs.prefs.spellcheck()).toBe(true);
    expect(fake.writes).toEqual([]);
  });

  it("follows the appearance event, tells the editors, and sends nothing back", async () => {
    const w = await openWindow();
    await startAndWait(w);
    const heard = vi.fn();
    w.spell.subscribeSpellcheck(heard);
    fake.externalSet({ spellcheck: false });
    await flush();
    expect(w.spell.spellcheck()).toBe(false);
    expect(w.prefs.prefs.spellcheck()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
    fake.externalSet({ theme: "emerald" });   // an event without a value for it leaves it alone
    await flush();
    expect(w.spell.spellcheck()).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("reaches the other window from the setter", async () => {
    const [main, capture] = [await openWindow(), await openWindow()];
    await startAndWait(capture);
    main.spell.setSpellcheck(false);
    await flush();
    expect(fake.file).toEqual({ spellcheck: false });
    expect(capture.spell.spellcheck()).toBe(false);
  });

  it("shows what the file holds when it refuses a change, and says so", async () => {
    fake.file = { spellcheck: true };
    const w = await openWindow();
    await startAndWait(w);
    fake.failSets = true;
    w.spell.setSpellcheck(false);
    await flush();
    expect(w.spell.spellcheck()).toBe(true);
    expect(w.prefs.prefs.spellcheck()).toBe(true);
    expect(w.toasts().map((t) => [t.kind, t.text])).toEqual([["error", "Could not save the spelling check setting."]]);
  });

  it("holds the choice in memory when localStorage cannot be used", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    fake.file = { spellcheck: false };
    const w = await openWindow();
    await startAndWait(w);
    expect(w.spell.spellcheck()).toBe(false);
    w.spell.setSpellcheck(true);
    expect(w.spell.spellcheck()).toBe(true);
  });
});
