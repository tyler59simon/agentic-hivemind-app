// @vitest-environment jsdom
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { powerExtensions } from "./extensions";
import {
  cancelPlayback, deleteMacro, loadMacros, MAX_MACROS, play, playMacro, registerCommand, runStep, saveMacro, toggleRecording, useRecorder, type Step, type Target,
} from "./macros";

// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

/** A target without a view: macros need only a state and a dispatch. */
function target(doc: string, head = 0): Target {
  const t: Target = {
    state: EditorState.create({ doc, selection: EditorSelection.cursor(head), extensions: [EditorState.allowMultipleSelections.of(true)] }),
    dispatch: (tr: Transaction) => { t.state = tr.state; },
  };
  return t;
}

// Test commands: to the start of the next line, or the end of the file from the last line (as Down does); and one that
// never does anything.
registerCommand("test-down", ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const to = line.number < state.doc.lines ? state.doc.line(line.number + 1).from : state.doc.length;
  if (to === state.selection.main.head) return false;
  dispatch(state.update({ selection: { anchor: to } }));
  return true;
});
registerCommand("test-stuck", () => false);

const slash: Step[] = [{ t: "text", s: "// " }, { t: "key", id: "test-down" }];

beforeEach(() => { useRecorder.setState({ recording: false, playing: false, steps: [] }); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("recording", () => {
  /** A real editor with the power extensions, so the recorded keys and typing go through its keymap and input handlers. */
  function editor(doc: string) {
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, extensions: [powerExtensions()] }) });
    const press = (key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) =>
      runScopeHandlers(view, new KeyboardEvent("keydown", { key, ...mods }), "editor");
    /** Typing as the editor does it: the input handlers see the text, then it goes in. */
    const type = (text: string) => {
      const { from, to } = view.state.selection.main;
      const insert = () => view.state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, insert))) view.dispatch(insert());
    };
    return { view, press, type };
  }

  it("records typed text and the keys that ran commands, and nothing while not recording", () => {
    const { view, press, type } = editor("one two\nthree\n");
    type("not recorded");
    useRecorder.getState().start();
    type("ab");
    type("c");
    press("Enter");
    press("Backspace");
    press("a", { ctrlKey: true });
    useRecorder.getState().stop();
    type("also not recorded");
    expect(useRecorder.getState().steps).toEqual([{ t: "text", s: "abc" }, { t: "key", id: "Enter" }, { t: "key", id: "Backspace" }, { t: "key", id: "Mod-a" }]);
    view.destroy();
  });

  it("replays a recording on another editor as the same edits", () => {
    const { view, press, type } = editor("x\n");
    useRecorder.getState().start();
    type("> ");
    press("Enter");
    useRecorder.getState().stop();
    const steps = useRecorder.getState().steps;
    expect(view.state.doc.toString()).toBe("> \nx\n");
    const again = target("y\n");
    for (const step of steps) runStep(again, step);
    expect(again.state.doc.toString()).toBe("> \ny\n");
    view.destroy();
  });

  it("the record key toggles recording, and Ctrl+Shift+P plays the last macro once", async () => {
    const { view, press, type } = editor("start");
    press("r", { ctrlKey: true, shiftKey: true });
    expect(useRecorder.getState().recording).toBe(true);
    type("!");
    press("r", { ctrlKey: true, shiftKey: true });
    expect(useRecorder.getState().recording).toBe(false);
    expect(useRecorder.getState().steps).toEqual([{ t: "text", s: "!" }]);
    // The key press itself is not a step.
    press("p", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("!!start"));
    view.destroy();
  });

  it("never runs a step on a read-only editor", () => {
    const state = EditorState.create({ doc: "a", extensions: [EditorState.readOnly.of(true)] });
    expect(runStep({ state, dispatch: () => { throw new Error("must not dispatch"); } }, { t: "text", s: "x" })).toBe(false);
  });

  it("toggleRecording does not start while a replay runs", () => {
    useRecorder.setState({ playing: true });
    toggleRecording();
    expect(useRecorder.getState().recording).toBe(false);
  });
});

describe("playing", () => {
  it("plays once, or N times", async () => {
    const t = target("");
    expect(await play(t, [{ t: "text", s: "ab" }], 1)).toBe(1);
    expect(t.state.doc.toString()).toBe("ab");
    expect(await play(t, [{ t: "text", s: "-" }], 3)).toBe(3);
    expect(t.state.doc.toString()).toBe("ab---");
    expect(await play(t, [{ t: "text", s: "-" }], 0)).toBe(0);
  });

  it("plays to the end of the file and stops there", async () => {
    const t = target("one\ntwo\nthree\nfour\n");
    const runs = await play(t, slash, "end");
    // One run per line; the run that leaves the cursor at the end of the file is the last.
    expect(t.state.doc.toString()).toBe("// one\n// two\n// three\n// four\n");
    expect(runs).toBe(4);
  });

  it("stops when a run leaves the cursor where it was and changed nothing", async () => {
    const t = target("a\nb\n", 1);
    expect(await play(t, [{ t: "key", id: "test-stuck" }], "end")).toBe(1);
    expect(t.state.doc.toString()).toBe("a\nb\n");
  });

  it("can be cancelled between runs", async () => {
    const t = target("x");
    const control = { cancelled: false };
    const steps: Step[] = [{ t: "text", s: "y" }];
    t.dispatch = ((orig) => (tr: Transaction) => { orig(tr); if (t.state.doc.length >= 5) control.cancelled = true; })(t.dispatch);
    expect(await play(t, steps, 1000, control)).toBe(4);
    expect(t.state.doc.toString()).toBe("yyyyx");
  });

  it("one replay at a time, and cancelPlayback stops it", async () => {
    const t = target("");
    let more = true;
    const first = playMacro(t, [{ t: "text", s: "a" }], 10_000_000);
    expect(useRecorder.getState().playing).toBe(true);
    expect(await playMacro(t, [{ t: "text", s: "b" }], 1)).toBe(0);
    setTimeout(() => { more = false; cancelPlayback(); }, 5);
    const runs = await first;
    expect(more).toBe(false);
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(10_000_000);
    expect(useRecorder.getState().playing).toBe(false);
    expect(t.state.doc.toString()).toBe("a".repeat(runs));
  });

  it("an unknown command in a saved macro is skipped, not fatal", async () => {
    const t = target("");
    await play(t, [{ t: "key", id: "gone-in-a-newer-version" }, { t: "text", s: "ok" }], 1);
    expect(t.state.doc.toString()).toBe("ok");
  });
});

describe("a large file", () => {
  it("plays to the end of 200,000 lines in slices, with time to spare", async () => {
    const doc = `${Array.from({ length: 200_000 }, (_, i) => `row ${i} ${"x".repeat(i % 20)}`).join("\n")}\n`;
    const t = target(doc);
    let yields = 0;
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { yields++; return real(fn, ms); }) as typeof setTimeout);
    const started = performance.now();
    const runs = await play(t, slash, "end");
    const took = Math.round(performance.now() - started);
    console.info(`macro to the end of a 200,000-line file: ${runs} runs in ${took} ms, ${yields} pauses for the window`);
    expect(runs).toBe(200_000);
    expect(t.state.doc.line(1).text).toBe("// row 0 ");
    expect(t.state.doc.line(200_000).text).toBe("// row 199999 xxxxxxxxxxxxxxxxxxx");
    expect(yields).toBeGreaterThan(0);
    expect(took).toBeLessThan(60_000);
  }, 120_000);
});

describe("saved macros", () => {
  const steps: Step[] = [{ t: "text", s: "x" }];

  it("saves, replaces by name, and deletes", () => {
    expect(loadMacros()).toEqual([]);
    expect(saveMacro("First", steps)).toEqual({ ok: true, macros: [{ name: "First", steps }] });
    const next = [{ t: "text", s: "y" } as Step];
    const done = saveMacro("first", next);
    expect(done.ok && done.macros).toEqual([{ name: "first", steps: next }]);
    expect(loadMacros()).toEqual([{ name: "first", steps: next }]);
    const gone = deleteMacro("first");
    expect(gone).toEqual({ ok: true, macros: [] });
    expect(loadMacros()).toEqual([]);
  });

  it("keeps at most 10, and refuses the 11th name but still replaces one", () => {
    for (let i = 1; i <= MAX_MACROS; i++) expect(saveMacro(`m${i}`, steps).ok).toBe(true);
    const refused = saveMacro("one too many", steps);
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("Up to 10") });
    expect(loadMacros()).toHaveLength(MAX_MACROS);
    expect(saveMacro("m3", [{ t: "text", s: "new" }]).ok).toBe(true);
    expect(loadMacros()).toHaveLength(MAX_MACROS);
    expect(deleteMacro("m1").ok).toBe(true);
    expect(saveMacro("one more", steps).ok).toBe(true);
  });

  it("refuses an empty name and an empty macro", () => {
    expect(saveMacro("  ", steps).ok).toBe(false);
    expect(saveMacro("empty", []).ok).toBe(false);
  });

  it("reports a storage that fails, and reads an empty list from one that is broken", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(saveMacro("a", steps)).toEqual({ ok: false, error: expect.stringContaining("could not be saved") });
    expect(deleteMacro("a")).toEqual({ ok: false, error: expect.stringContaining("could not be deleted") });
    set.mockRestore();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(loadMacros()).toEqual([]);
  });

  it("ignores stored data that is not a list of macros", () => {
    localStorage.setItem("hivemind.macros", "not json");
    expect(loadMacros()).toEqual([]);
    localStorage.setItem("hivemind.macros", JSON.stringify({ name: "x" }));
    expect(loadMacros()).toEqual([]);
    localStorage.setItem("hivemind.macros", JSON.stringify([{ name: "ok", steps: [{ t: "text", s: "a" }] }, { name: "bad", steps: [{ t: "oops" }] }, 5]));
    expect(loadMacros()).toEqual([{ name: "ok", steps: [{ t: "text", s: "a" }] }]);
  });
});
