// Replaying a macro without touching the editor (NS-6A, UI-2). Commands run against a copy of the editor's state, a step at
// a time, with no drawing and no layout; what they changed comes back as one transaction. That is what lets a macro run
// at thousands of runs a second on a large file, where a transaction per step through the real view manages about ninety.
//
// The commands are the editor's own. They take a view, so they get a stand-in that answers from the copy of the state:
// `state` and `dispatch`, and the few view methods that would look at the screen (a line's extent, a move up or down, a
// move to the start or end of a line). Text that does not wrap and runs left to right needs nothing from the screen for
// those; anything else is replayed on the real view.
import { ChangeSet, countColumn, EditorSelection, findColumn, Transaction, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import { Direction, type EditorView } from "@codemirror/view";

/** Whether a replay on `view` can run on a copy of its state: lines that do not wrap, text that runs left to right. */
export const canReplayHeadless = (view: EditorView) => !view.contentDOM.classList.contains("cm-lineWrapping") && view.textDirection === Direction.LTR;

/** One change set from many, joined two at a time so the work stays proportional to their number. */
export function composeAll(sets: ChangeSet[]): ChangeSet | null {
  let level = sets;
  while (level.length > 1) {
    const next: ChangeSet[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? level[i].compose(level[i + 1]) : level[i]);
    level = next;
  }
  return level[0] ?? null;
}

export interface Session {
  /** What commands are given as the view. */
  view: EditorView;
  /** The copy of the state as the commands have left it. */
  state: () => EditorView["state"];
  /** Everything the commands changed, as one change set (null when nothing changed). */
  changes: () => ChangeSet | null;
}

export function session(real: EditorView): Session {
  let cur = real.state;
  const parts: ChangeSet[] = [];
  const put = (tr: Transaction) => {
    cur = tr.state;
    if (!tr.changes.empty) parts.push(tr.changes);
  };
  const lineHeight = () => real.defaultLineHeight || 20;
  const view = Object.create(real) as EditorView;
  Object.defineProperties(view, {
    state: { get: () => cur },
    dispatch: { value: (...args: unknown[]) => put(args[0] instanceof Transaction ? args[0] : cur.update(...(args as TransactionSpec[]))) },
    // The real view keeps what it worked out for the lines of the text it shows; this one starts with none.
    bidiCache: { value: [] },
    lineBlockAt: {
      value: (pos: number) => {
        const line = cur.doc.lineAt(pos);
        return { from: line.from, to: line.to, length: line.length, top: 0, height: lineHeight(), bottom: lineHeight() };
      },
    },
    // Lines do not wrap, so the start and end of a line are the start and end of the visual line.
    moveToLineBoundary: {
      value: (start: SelectionRange, forward: boolean) => {
        const line = cur.doc.lineAt(start.head);
        return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
      },
    },
    // Up and down keep the column the move began in (not a pixel position, as on screen): the same for text in a fixed font.
    moveVertically: {
      value: (start: SelectionRange, forward: boolean, distance?: number) => {
        const { doc, tabSize } = cur;
        const line = doc.lineAt(start.head);
        const col = start.goalColumn ?? countColumn(line.text, tabSize, start.head - line.from);
        const rows = distance === undefined ? 1 : Math.max(1, Math.round(distance / lineHeight()));
        const number = line.number + (forward ? rows : -rows);
        // Past the first or last line, the cursor goes to the start or the end of the text.
        if (number < 1 || number > doc.lines) return EditorSelection.cursor(forward ? doc.length : 0, undefined, undefined, col);
        const target = doc.line(number);
        return EditorSelection.cursor(target.from + findColumn(target.text, col, tabSize), undefined, undefined, col);
      },
    },
  });
  return { view, state: () => cur, changes: () => composeAll(parts) };
}
