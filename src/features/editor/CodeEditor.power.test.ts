// @vitest-environment jsdom
// NS-6A: what a file tab adds to the editor, and that a Memory note gets none of it.
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { playMacro, type Target } from "../power/macros";
import { editorExtensions, type CodeEditorProps, type PowerProps, type Switches } from "./CodeEditor";

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const props = (over: Partial<CodeEditorProps> = {}): CodeEditorProps => ({
  doc: "foo bar foo\nbaz foo\nline three\n", docVersion: 0, language: "markdown", live: false, readOnly: false, lineNumbers: false,
  onChange: () => {}, onSave: () => {}, titles: () => [], onOpenLink: () => {}, ...over,
});
const power = (over: Partial<PowerProps> = {}): PowerProps => ({ id: "tab-1", fileName: "notes.txt", on: true, ...over });
const switches = (): Switches => ({ preview: new Compartment(), readOnly: new Compartment(), gutter: new Compartment(), rich: new Compartment() });
const stateOf = (p: CodeEditorProps, sw = switches()) => EditorState.create({ doc: p.doc, extensions: editorExtensions(p, { current: p }, sw) });

describe("what only a file tab has", () => {
  it("a note keeps exactly the extension list it had before NS-6A", () => {
    const sw = switches();
    const list = editorExtensions(props(), { current: props() }, sw);
    // history, selection drawing, five Markdown pieces, keymap, preview, theme, read-only, gutter, change listener and the
    // link handler: 14 entries. Power editing adds none of its own to a note.
    expect(list).toHaveLength(14);
    expect(sw.power).toBeUndefined();
    expect(sw.language).toBeUndefined();
  });

  it("a file tab's text file adds the power switch and the language switch", () => {
    const sw = switches();
    const p = props({ language: "text", lineNumbers: true, power: power() });
    expect(editorExtensions(p, { current: p }, sw)).toHaveLength(12);
    expect(sw.power).toBeDefined();
    expect(sw.language).toBeDefined();
  });

  it("has several selections in source and in text files, never in a note or in Live", () => {
    const two = EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]);
    const rangesIn = (p: CodeEditorProps) => stateOf(p).update({ selection: two }).state.selection.ranges.length;
    expect(rangesIn(props())).toBe(1);
    expect(rangesIn(props({ language: "text", lineNumbers: true, power: power() }))).toBe(2);
    expect(rangesIn(props({ power: power() }))).toBe(2);
    expect(rangesIn(props({ live: true, power: power({ on: false }) }))).toBe(1);
    expect(stateOf(props()).facet(EditorState.allowMultipleSelections)).toBe(false);
  });

  it("selects the next and all occurrences: several ranges in a file, one in a note", () => {
    const run = (p: CodeEditorProps, command: typeof selectNextOccurrence) => {
      let state = stateOf(p).update({ selection: EditorSelection.single(0, 3) }).state;
      command({ state, dispatch: (tr) => { state = tr.state; } });
      return state.selection.ranges.map((r) => [r.from, r.to]);
    };
    const file = props({ language: "text", power: power() });
    expect(run(file, selectNextOccurrence)).toEqual([[0, 3], [8, 11]]);
    expect(run(file, selectSelectionMatches)).toEqual([[0, 3], [8, 11], [16, 19]]);
    expect(run(props(), selectNextOccurrence)).toHaveLength(1);
    expect(run(props(), selectSelectionMatches)).toHaveLength(1);
  });
});

describe("rectangular selection by keyboard", () => {
  const view = (p: CodeEditorProps, at: number) => {
    const v = new EditorView({ parent: document.body, state: stateOf(p).update({ selection: EditorSelection.cursor(at) }).state });
    const press = (key: string) => runScopeHandlers(v, new KeyboardEvent("keydown", { key, altKey: true, shiftKey: true }), "editor");
    return { v, press };
  };
  const ranges = (v: EditorView) => v.state.selection.ranges.map((r) => [r.anchor, r.head]);

  it("Alt+Shift+Down and Right grow a block of columns across lines", () => {
    const { v, press } = view(props({ language: "text", power: power() }), 2);   // "fo|o bar foo"
    expect(press("ArrowDown")).toBe(true);
    expect(ranges(v)).toEqual([[2, 2], [14, 14]]);
    expect(press("ArrowDown")).toBe(true);
    expect(ranges(v)).toEqual([[2, 2], [14, 14], [22, 22]]);
    expect(press("ArrowRight")).toBe(true);
    expect(ranges(v)).toEqual([[2, 3], [14, 15], [22, 23]]);
    expect(v.state.selection.mainIndex).toBe(2);
    // Up shrinks it again from the moving end; Left narrows.
    press("ArrowUp");
    press("ArrowLeft");
    expect(ranges(v)).toEqual([[2, 2], [14, 14]]);
    v.destroy();
  });

  it("keeps the column across a short line", () => {
    const p = props({ doc: "abcdef\nab\nabcdef\n", language: "text", power: power() });
    const { v, press } = view(p, 5);
    press("ArrowDown");
    press("ArrowDown");
    expect(ranges(v)).toEqual([[5, 5], [9, 9], [15, 15]]);
    v.destroy();
  });

  it("is not there in a note, where the keys keep the commands they had", () => {
    const { v, press } = view(props(), 2);
    // Shift-Alt-Down duplicates the line in the plain editor.
    expect(press("ArrowDown")).toBe(true);
    expect(v.state.doc.line(1).text).toBe("foo bar foo");
    expect(v.state.doc.line(2).text).toBe("foo bar foo");
    expect(v.state.selection.ranges).toHaveLength(1);
    v.destroy();
  });
});

describe("macro replay", () => {
  it("reports its edits to the page once, when it ends, and typing is still reported as it is made", async () => {
    const reported: string[] = [];
    const p = props({ doc: "start", language: "text", power: power(), onChange: (text) => reported.push(text) });
    const view = new EditorView({ parent: document.body, state: stateOf(p) });
    view.dispatch({ changes: { from: 0, insert: "a" }, userEvent: "input.type" });
    expect(reported).toEqual(["astart"]);
    const runs = await playMacro(view as unknown as Target, [{ t: "text", s: "y" }], 50);
    expect(runs).toBe(50);
    expect(reported).toHaveLength(2);
    expect(reported[1]).toBe(view.state.doc.toString());
    expect(reported[1].split("y").length - 1).toBe(50);
    view.dispatch({ changes: { from: 0, insert: "b" }, userEvent: "input.type" });
    expect(reported).toHaveLength(3);
    view.destroy();
  });
});
