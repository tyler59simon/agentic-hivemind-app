// What file tabs add to the editor (NS-6A): several cursors and selections, rectangular selection, and the macro keys.
// A Memory note never gets these; `CodeEditor` adds them only when a file tab asks.
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { countColumn, EditorSelection, EditorState, findColumn, Prec, StateEffect, StateField, type Extension, type StateCommand } from "@codemirror/state";
import { crosshairCursor, EditorView, keymap, rectangularSelection, type KeyBinding } from "@codemirror/view";
import { cancelPlayback, isReplaying, playLast, registerCommand, toggleRecording, useRecorder, type Run, type Target } from "./macros";

// Rectangular selection by keyboard --------------------------------------------------------------------------------------

interface Spot { line: number; col: number }
interface Rect { anchor: Spot; head: Spot }

/** The rectangle last made by Alt+Shift+arrows. The columns are kept apart from the ranges, so a short line does not
 *  narrow the rectangle for the lines after it. Any other selection change forgets it. */
const setRect = StateEffect.define<Rect>();
const rectField = StateField.define<Rect | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRect)) return e.value;
    return tr.selection || tr.docChanged ? null : value;
  },
});

const spotOf = (state: EditorState, pos: number): Spot => {
  const line = state.doc.lineAt(pos);
  return { line: line.number, col: countColumn(line.text, state.tabSize, pos - line.from) };
};

/** Grow or shrink the rectangle by one line or one column at its moving corner. */
const growRect = (lines: number, cols: number): StateCommand => ({ state, dispatch }) => {
  const known = state.field(rectField, false);
  const main = state.selection.main;
  const anchor = known?.anchor ?? spotOf(state, main.anchor);
  const from = known?.head ?? spotOf(state, main.head);
  const head: Spot = { line: Math.min(Math.max(from.line + lines, 1), state.doc.lines), col: Math.max(0, from.col + cols) };
  const ranges = [];
  const step = head.line >= anchor.line ? 1 : -1;
  for (let n = anchor.line; n !== head.line + step; n += step) {
    const line = state.doc.line(n);
    ranges.push(EditorSelection.range(line.from + findColumn(line.text, anchor.col, state.tabSize), line.from + findColumn(line.text, head.col, state.tabSize)));
  }
  // The range on the moving line is the main one, so the editor scrolls to it.
  dispatch(state.update({ selection: EditorSelection.create(ranges, ranges.length - 1), effects: setRect.of({ anchor, head }), scrollIntoView: true, userEvent: "select" }));
  return true;
};

// Recording keys --------------------------------------------------------------------------------------------------------

/** The commands a macro records, by key. The same key always means the same command, so a saved macro replays after a
 *  restart. Alt+Shift+arrows are the rectangular selection below, which is why the editor's own Shift-Alt-Arrow commands
 *  (duplicate line, select by syntax) are not here; the line tools menu has duplicate. */
const columnKeys: KeyBinding[] = [
  { key: "Shift-Alt-ArrowUp", run: growRect(-1, 0), preventDefault: true },
  { key: "Shift-Alt-ArrowDown", run: growRect(1, 0), preventDefault: true },
  { key: "Shift-Alt-ArrowLeft", run: growRect(0, -1), preventDefault: true },
  { key: "Shift-Alt-ArrowRight", run: growRect(0, 1), preventDefault: true },
];

const columnIds = new Set(columnKeys.map((b) => b.key));
const recordable: readonly KeyBinding[] = [
  ...columnKeys,
  ...defaultKeymap.filter((b) => !columnIds.has(b.key)),
  indentWithTab,
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Mod-Shift-l", run: selectSelectionMatches },
];

const idOf = (b: KeyBinding) => b.key ?? b.win ?? b.linux ?? b.mac;

/** `recordable` with each command noting itself in the macro being recorded. A key bound twice with different commands
 *  is not recorded, since its id would not say which one ran. */
function recorded(): KeyBinding[] {
  const counts = new Map<string, number>();
  for (const b of recordable) { const id = idOf(b); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  const wrap = (id: string, run: (v: EditorView) => boolean) => {
    registerCommand(id, run as unknown as Run);
    return (view: EditorView) => { const done = run(view); if (done) useRecorder.getState().key(id); return done; };
  };
  return recordable.map((b) => {
    const id = idOf(b);
    if (!id || counts.get(id) !== 1) return b;
    return { ...b, run: b.run && wrap(id, b.run), shift: b.shift && wrap(`${id}|shift`, b.shift) };
  });
}

/** Several selections, rectangular selection (Alt+drag, Alt+Shift+arrows) and the macro keys: Ctrl+Shift+R records or
 *  stops, Ctrl+Shift+P plays the last macro, Escape cancels a replay. */
export function powerExtensions(): Extension {
  return [
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    rectField,
    Prec.high(keymap.of([
      // The keys are taken whatever the editor does with them, so the page does not reload (Ctrl+Shift+R) or print.
      { key: "Mod-Shift-r", run: () => { toggleRecording(); return true; }, preventDefault: true },
      { key: "Mod-Shift-p", run: (view) => { playLast(view as unknown as Target); return true; }, preventDefault: true },
      { key: "Escape", run: () => { if (!useRecorder.getState().playing) return false; cancelPlayback(); return true; } },
      ...recorded(),
    ])),
    // The editor takes no typing while a macro replays on a copy of its text: what is typed now would not be in it.
    EditorView.domEventHandlers({
      keydown: (e, view) => { if (!isReplaying(view) || e.key === "Escape") return false; e.preventDefault(); return true; },
      beforeinput: (e, view) => { if (!isReplaying(view)) return false; e.preventDefault(); return true; },
      paste: (e, view) => { if (!isReplaying(view)) return false; e.preventDefault(); return true; },
      cut: (e, view) => { if (!isReplaying(view)) return false; e.preventDefault(); return true; },
      drop: (e, view) => { if (!isReplaying(view)) return false; e.preventDefault(); return true; },
    }),
    EditorView.inputHandler.of((_view, _from, _to, text) => { useRecorder.getState().text(text); return false; }),
  ];
}
