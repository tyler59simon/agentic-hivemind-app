// @vitest-environment jsdom
// NS-6A, UI-2: a macro replayed on a real editor runs on a copy of its state and reaches the editor as one transaction.
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { powerExtensions } from "./extensions";
import { composeAll } from "./headless";
import { cancelPlayback, playMacro, useRecorder, type Step, type Target } from "./macros";

vi.setConfig({ testTimeout: 120_000 });
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

// End of the line, type ";", one line down: the macro that took 95 seconds for 8,566 lines on the real editor.
const semicolons: Step[] = [{ t: "key", id: "End" }, { t: "text", s: ";" }, { t: "key", id: "ArrowDown" }];

function editor(doc: string, wrap = false, cursor = 0) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [history(), powerExtensions(), ...(wrap ? [EditorView.lineWrapping] : [])] }),
  });
  const dispatches: number[] = [];
  const real = view.dispatch.bind(view);
  view.dispatch = ((...args: Parameters<typeof real>) => { dispatches.push(1); return real(...args); }) as typeof view.dispatch;
  return { view, dispatches: () => dispatches.length };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `row ${i} ${"x".repeat(i % 20)}`);

beforeEach(() => { useRecorder.setState({ recording: false, playing: false, steps: [], runs: 0 }); });
afterEach(() => { document.body.innerHTML = ""; });

describe("a macro on a real editor", () => {
  it("gives the same result as the keys would: a semicolon at the end of every line", async () => {
    const text = lines(50);
    const { view } = editor(`${text.join("\n")}\n`);
    const runs = await playMacro(view as unknown as Target, semicolons, "end");
    expect(runs).toBe(50);
    expect(view.state.doc.toString()).toBe(`${text.map((l) => `${l};`).join("\n")}\n`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("keeps the column when it moves down, and goes to the end of the text from the last line", async () => {
    const { view } = editor("abcdef\nab\nabcdef", false, 5);
    await playMacro(view as unknown as Target, [{ t: "key", id: "ArrowDown" }], 1);
    expect(view.state.selection.main.head).toBe(9);          // the end of "ab"
    await playMacro(view as unknown as Target, [{ t: "key", id: "ArrowDown" }], 1);
    expect(view.state.selection.main.head).toBe(15);         // column 5 of the last line again
    await playMacro(view as unknown as Target, [{ t: "key", id: "ArrowDown" }], 1);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    await playMacro(view as unknown as Target, [{ t: "key", id: "ArrowUp" }], 1);
    expect(view.state.selection.main.head).toBe(9);
    view.destroy();
  });

  it("makes one transaction for a long replay, and one Undo reverts all of it", async () => {
    const original = `${lines(3000).join("\n")}\n`;
    const { view, dispatches } = editor(original);
    const runs = await playMacro(view as unknown as Target, semicolons, "end");
    expect(runs).toBe(3000);
    // One to the editor for the whole replay (no other transaction: the replay's own work is on a copy).
    expect(dispatches()).toBe(1);
    expect(view.state.doc.toString()).not.toBe(original);
    expect(view.state.doc.toString().split("\n").filter((l) => l.endsWith(";"))).toHaveLength(3000);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    expect(undo(view)).toBe(false);
    view.destroy();
  });

  it("is cancelled by Esc with what was done so far, still as one transaction", async () => {
    const original = `${lines(100_000).join("\n")}\n`;
    const { view, dispatches } = editor(original);
    const playing = playMacro(view as unknown as Target, semicolons, "end");
    setTimeout(cancelPlayback, 30);
    const runs = await playing;
    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThan(100_000);
    expect(dispatches()).toBe(1);
    expect(view.state.doc.toString().split("\n").filter((l) => l.endsWith(";"))).toHaveLength(runs);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    view.destroy();
  });

  it("applies nothing, and says so, when the text changed some other way meanwhile", async () => {
    const { view } = editor(`${lines(20_000).join("\n")}\n`);
    const playing = playMacro(view as unknown as Target, semicolons, "end");
    view.dispatch({ changes: { from: 0, insert: "changed elsewhere\n" } });
    await expect(playing).rejects.toThrow(/nothing was applied/);
    expect(view.state.doc.line(1).text).toBe("changed elsewhere");
    expect(view.state.doc.toString().includes(";")).toBe(false);
    expect(useRecorder.getState().playing).toBe(false);
    view.destroy();
  });

  it("takes no typing while it replays", async () => {
    const { view } = editor(`${lines(20_000).join("\n")}\n`);
    const playing = playMacro(view as unknown as Target, semicolons, "end");
    const typed = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    view.contentDOM.dispatchEvent(typed);
    const input = new Event("beforeinput", { cancelable: true, bubbles: true });
    view.contentDOM.dispatchEvent(input);
    expect([typed.defaultPrevented, input.defaultPrevented]).toEqual([true, true]);
    await playing;
    const after = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    view.contentDOM.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("replays a wrapped editor step by step on the editor itself, where the screen decides where a line ends", async () => {
    const { view, dispatches } = editor("one\ntwo\nthree\n", true);
    await playMacro(view as unknown as Target, [{ t: "text", s: "-" }, { t: "key", id: "Enter" }], 3);
    expect(dispatches()).toBeGreaterThan(3);
    expect(view.state.doc.toString().startsWith("-\n-\n-\n")).toBe(true);
    view.destroy();
  });

  it("does the work in slices and reports its progress between them", async () => {
    const { view } = editor(`${lines(40_000).join("\n")}\n`);
    const seen: number[] = [];
    const stop = useRecorder.subscribe((s) => { if (s.playing) seen.push(s.runs); });
    await playMacro(view as unknown as Target, semicolons, "end");
    stop();
    const slices = new Set(seen.filter((n) => n > 0)).size;
    expect(slices).toBeGreaterThan(1);
    console.info(`40,000 runs in ${slices} slices of about ${Math.round(40_000 / slices)} runs`);
    view.destroy();
  });
});

describe("the whole of a large file", () => {
  it("plays End, ';', ArrowDown over 155,000 lines (about 8 MB) in seconds", async () => {
    const text = `${Array.from({ length: 155_000 }, (_, i) => `2026-11-22 10:${String(i % 60).padStart(2, "0")}:00 INFO request ${i} handled by worker ${i % 16} in ${i % 997} ms`).join("\n")}\n`;
    expect(text.length).toBeGreaterThan(8_000_000);
    const { view, dispatches } = editor(text);
    const started = performance.now();
    const runs = await playMacro(view as unknown as Target, semicolons, "end");
    const took = Math.round(performance.now() - started);
    console.info(`macro over ${runs} lines of an ${(text.length / 1e6).toFixed(1)} MB file: ${took} ms (${Math.round(runs / (took / 1000))} runs a second), ${dispatches()} dispatch to the editor`);
    expect(runs).toBe(155_000);
    expect(dispatches()).toBe(1);
    expect(view.state.doc.line(1).text.endsWith(";")).toBe(true);
    expect(view.state.doc.line(155_000).text.endsWith(";")).toBe(true);
    expect(took).toBeLessThan(15_000);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.length).toBe(text.length);
    view.destroy();
  });
});

describe("joining change sets", () => {
  it("composes many small changes into the one change they make together", () => {
    const base = EditorState.create({ doc: "abcdef" });
    let state = base;
    const sets = [];
    for (const [at, text] of [[0, "1"], [4, "2"], [8, "3"], [1, "4"], [3, "5"]] as const) {
      const tr = state.update({ changes: { from: at, insert: text } });
      sets.push(tr.changes);
      state = tr.state;
    }
    const all = composeAll(sets)!;
    expect(all.apply(base.doc).toString()).toBe(state.doc.toString());
    expect(composeAll([])).toBeNull();
    expect(composeAll([sets[0]])).toBe(sets[0]);
  });
});
