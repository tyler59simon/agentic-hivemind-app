// Markdown edits for the page toolbar and the slash menu (NS-3A). Each takes the editor state and returns the change
// to dispatch, so they are tested without a view.
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { NEW_TABLE } from "./tables";

const spec = (tr: TransactionSpec): TransactionSpec => ({ ...tr, scrollIntoView: true, userEvent: "input.format" });

/** Line prefix edits: a cursor in or before the old prefix ends up after the new one. */
function linePrefixes(state: EditorState, changes: { from: number; to: number; insert: string }[]): TransactionSpec {
  const set = state.changes(changes);
  const moved = (pos: number) => {
    const c = changes.find((c) => pos >= c.from && pos <= c.to);
    return c ? set.mapPos(c.from, -1) + c.insert.length : set.mapPos(pos, 1);
  };
  const ranges = state.selection.ranges.map((r) => EditorSelection.range(moved(r.anchor), moved(r.head)));
  return spec({ changes: set, selection: EditorSelection.create(ranges, state.selection.mainIndex) });
}

/** Wrap the selection in `mark` (`**`, `*`, `` ` ``, `==`, `$`), or unwrap it when it is already wrapped. An empty
 *  selection gets an empty pair with the cursor inside. */
export function toggleWrap(state: EditorState, mark: string): TransactionSpec {
  const n = mark.length;
  return spec(state.changeByRange((r) => {
    const before = state.sliceDoc(r.from - n, r.from), after = state.sliceDoc(r.to, r.to + n);
    if (before === mark && after === mark) {
      return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
    }
    const text = state.sliceDoc(r.from, r.to);
    if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
      return { changes: { from: r.from, to: r.to, insert: text.slice(n, -n) }, range: EditorSelection.range(r.from, r.to - 2 * n) };
    }
    return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + n, r.to + n) };
  }));
}

/** The line numbers the selection covers, each once. */
function selectedLines(state: EditorState): number[] {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) out.add(l);
  }
  return [...out].sort((a, b) => a - b);
}

const LIST = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?/;

/** Give every selected line the prefix `kind` makes (`- `, `1. `, `- [ ] `, `> `), or take it away when every line
 *  already has it. A line's other list or quote prefix is replaced. */
export function toggleLinePrefix(state: EditorState, kind: "bullet" | "number" | "task" | "quote"): TransactionSpec {
  const lines = selectedLines(state).map((n) => state.doc.line(n));
  const has = (text: string) => kind === "bullet" ? /^\s*[-*+] (?!\[[ xX]\] )/.test(text)
    : kind === "number" ? /^\s*\d+[.)] /.test(text)
      : kind === "task" ? /^\s*[-*+] \[[ xX]\] /.test(text) : /^\s*> ?/.test(text);
  const all = lines.every((l) => has(l.text));
  const changes = lines.map((line, i) => {
    const m = LIST.exec(line.text)!;
    const indent = m[1];
    const prefix = all ? "" : kind === "bullet" ? "- " : kind === "number" ? `${i + 1}. ` : kind === "task" ? "- [ ] " : "> ";
    return { from: line.from + indent.length, to: line.from + m[0].length, insert: prefix };
  });
  return linePrefixes(state, changes);
}

/** Make the selected lines headings of `level`, or plain lines when they already are. */
export function setHeading(state: EditorState, level: number): TransactionSpec {
  const lines = selectedLines(state).map((n) => state.doc.line(n));
  const mark = "#".repeat(level) + " ";
  const all = lines.every((l) => l.text.startsWith(mark));
  return linePrefixes(state, lines.map((line) => {
    const m = /^#{1,6} /.exec(line.text);
    return { from: line.from, to: line.from + (m ? m[0].length : 0), insert: all ? "" : mark };
  }));
}

/** Insert `text` as its own block at the cursor: in place of an empty line, or after the cursor's line, with a blank
 *  line between it and any text before or after. `cursor` is the offset in `text` to leave the cursor at. */
export function insertBlock(state: EditorState, text: string, cursor = text.length): TransactionSpec {
  const line = state.doc.lineAt(state.selection.main.head);
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
  const empty = line.text.trim() === "";
  const from = empty ? line.from : line.to;
  const before = empty ? (prev.trim() ? "\n" : "") : "\n\n";
  const after = next.trim() ? "\n" : "";
  return spec({ changes: { from, to: line.to, insert: before + text + after }, selection: { anchor: from + before.length + cursor } });
}

/** `[selection](url)` with "url" selected, or `[](url)` with the cursor in the label. */
export function insertLink(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  const label = state.sliceDoc(r.from, r.to);
  const insert = `[${label}](url)`;
  const selection = label ? EditorSelection.range(r.from + label.length + 3, r.from + label.length + 6) : EditorSelection.cursor(r.from + 1);
  return spec({ changes: { from: r.from, to: r.to, insert }, selection });
}

/** Inline code for a selection within a line, a fence around lines otherwise. */
export function toggleCode(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  if (state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number && (!r.empty || state.doc.lineAt(r.head).text.trim())) return toggleWrap(state, "`");
  const first = state.doc.lineAt(r.from), last = state.doc.lineAt(r.to);
  if (r.empty) return insertBlock(state, "```\n\n```", 4);
  return spec({ changes: [{ from: first.from, insert: "```\n" }, { from: last.to, insert: "\n```" }] });
}

/** Inline math for a selection within a line, a `$$` block otherwise. */
export function insertMath(state: EditorState): TransactionSpec {
  const r = state.selection.main;
  if (!r.empty && state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number) return toggleWrap(state, "$");
  return insertBlock(state, "$$\n\n$$", 3);
}

export const insertTable = (state: EditorState) => insertBlock(state, NEW_TABLE, 2);
export const insertCallout = (state: EditorState, type = "note") => insertBlock(state, `> [!${type}] Title\n> `);
export const insertMermaid = (state: EditorState) => insertBlock(state, "```mermaid\nflowchart LR\n  A --> B\n```", 25);
export const insertRule = (state: EditorState) => insertBlock(state, "---");
