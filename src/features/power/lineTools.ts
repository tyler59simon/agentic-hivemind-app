// Line tools for Source mode and text files (NS-6A). The transforms are pure functions over arrays of lines. A tool plans
// its edits from the editor state and dispatches them as one transaction, so one Undo reverts it.
//
// Scope: with a selection, a tool works on the whole lines the selection touches (case tools on the exact selected text);
// with only cursors, it works on the whole file. A trailing newline is not a line of its own: it stays where it is.
import { copyLineDown, moveLineDown, moveLineUp } from "@codemirror/commands";
import type { ChangeSpec, EditorState, Transaction, TransactionSpec } from "@codemirror/state";

/** What a tool needs: an editor view fits. */
export interface Target { state: EditorState; dispatch: (tr: Transaction) => void }

export type SortMode = "ascending" | "descending" | "insensitive" | "numeric";

const NUMBER = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/** `lines` sorted. Ascending and descending compare UTF-16 code units; insensitive compares lower-cased lines; numeric
 *  orders by the number a line starts with, and lines that start with none stay at the end in their old order. Equal keys
 *  keep their old order. */
export function sortLines(lines: string[], mode: SortMode): string[] {
  if (mode === "ascending") return lines.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (mode === "descending") return lines.slice().sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (mode === "insensitive") {
    return lines.map((line) => ({ line, key: line.toLowerCase() }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((k) => k.line);
  }
  const keyed = lines.map((line) => ({ line, n: NUMBER.exec(line)?.[1] ?? null }))
    .map((k) => ({ line: k.line, n: k.n === null ? NaN : Number(k.n) }));
  return keyed.sort((a, b) => {
    const an = Number.isNaN(a.n), bn = Number.isNaN(b.n);
    if (an || bn) return an === bn ? 0 : an ? 1 : -1;
    return a.n - b.n;
  }).map((k) => k.line);
}

/** `lines` without any line that came before it (the first of each stays). Blank lines count as lines too. */
export function removeDuplicates(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export const trimTrailing = (lines: string[]) => lines.map((l) => l.replace(/[ \t]+$/, ""));

/** One line from several: a single space between the pieces, no blank pieces, the first line's indentation kept. */
export function joinLines(lines: string[]): string {
  return lines.map((l, i) => (i === 0 ? l.trimEnd() : l.trim())).filter(Boolean).join(" ");
}

/** Every tab becomes the spaces to the next tab stop. */
export function tabsToSpaces(lines: string[], size: number): string[] {
  return lines.map((line) => {
    if (!line.includes("\t")) return line;
    let out = "";
    for (const ch of line) out += ch === "\t" ? " ".repeat(size - (out.length % size)) : ch;
    return out;
  });
}

/** Indentation made of spaces becomes tabs where a whole tab stop fits; spaces inside a line are left alone. */
export function spacesToTabs(lines: string[], size: number): string[] {
  return lines.map((line) => {
    const lead = /^[ \t]*/.exec(line)![0];
    if (!lead.includes(" ")) return line;
    let width = 0;
    for (const ch of lead) width = ch === "\t" ? width + size - (width % size) : width + 1;
    return "\t".repeat(Math.floor(width / size)) + " ".repeat(width % size) + line.slice(lead.length);
  });
}

/** The first letter of every word in capitals, the rest in lower case. A word is a run of letters and digits; an
 *  apostrophe does not end one. */
export const titleCase = (text: string) =>
  text.toLowerCase().replace(/(^|[^\p{L}\p{N}_'’])(\p{L})/gu, (_m, before: string, letter: string) => before + letter.toUpperCase());

/** A block of whole lines: `from` is a line start, `to` the end of the last line (before its break). */
interface Block { from: number; to: number }

const anySelected = (state: EditorState) => state.selection.ranges.some((r) => !r.empty);

/** The end of the last line that holds text: a trailing newline is not a line of its own. */
function textEnd(state: EditorState): number {
  const { doc } = state;
  return doc.lines > 1 && doc.line(doc.lines).length === 0 ? doc.line(doc.lines - 1).to : doc.length;
}

function merge(blocks: Block[]): Block[] {
  const sorted = blocks.slice().sort((a, b) => a.from - b.from);
  const out: Block[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else out.push({ ...b });
  }
  return out;
}

/** The whole lines to work on: those the selection touches, or the whole file when nothing is selected. */
export function blocksOf(state: EditorState): Block[] {
  if (!anySelected(state)) return state.doc.length === 0 ? [] : [{ from: 0, to: textEnd(state) }];
  const blocks: Block[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) continue;
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    // A selection that ends at the start of a line does not include that line.
    if (r.to === last.from && last.number > first.number) last = state.doc.line(last.number - 1);
    blocks.push({ from: first.from, to: last.to });
  }
  return merge(blocks);
}

/** Edits that replace each block by `transform` of its lines. When the line count stays the same and `perLine` is set,
 *  only the lines that changed are replaced, so cursors on the others stay put. */
function planBlocks(state: EditorState, transform: (lines: string[]) => string[], perLine = false): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (const block of blocksOf(state)) {
    const lines = state.doc.sliceString(block.from, block.to).split("\n");
    const out = transform(lines);
    if (out.length === lines.length && out.every((l, i) => l === lines[i])) continue;
    if (perLine && out.length === lines.length) {
      let pos = block.from;
      lines.forEach((line, i) => {
        if (out[i] !== line) changes.push({ from: pos, to: pos + line.length, insert: out[i] });
        pos += line.length + 1;
      });
    } else {
      changes.push({ from: block.from, to: block.to, insert: out.join("\n") });
    }
  }
  return changes;
}

/** Edits that replace the selected text by `transform` of it, or each line of the file when nothing is selected. */
function planText(state: EditorState, transform: (text: string) => string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  if (!anySelected(state)) {
    let pos = 0;
    for (const line of state.doc.iterLines()) {
      const out = transform(line);
      if (out !== line) changes.push({ from: pos, to: pos + line.length, insert: out });
      pos += line.length + 1;
    }
    return changes;
  }
  for (const r of state.selection.ranges) {
    if (r.empty) continue;
    const text = state.sliceDoc(r.from, r.to);
    const out = transform(text);
    if (out !== text) changes.push({ from: r.from, to: r.to, insert: out });
  }
  return changes;
}

/** The lines a join works on: those the selection touches (at least two, so one line joins with the next), or each
 *  cursor's line with the next. */
function joinBlocks(state: EditorState): Block[] {
  const { doc } = state;
  const blocks: Block[] = [];
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from);
    let last = doc.lineAt(r.to);
    if (!r.empty && r.to === last.from && last.number > first.number) last = doc.line(last.number - 1);
    if (last.number === first.number && first.number < doc.lines) last = doc.line(first.number + 1);
    if (last.number > first.number) blocks.push({ from: first.from, to: last.to });
  }
  return merge(blocks);
}

function planJoin(state: EditorState): ChangeSpec[] {
  return joinBlocks(state).map((b) => ({ from: b.from, to: b.to, insert: joinLines(state.doc.sliceString(b.from, b.to).split("\n")) }));
}

export interface LineTool {
  id: string;
  label: string;
  /** Group name in the menu. */
  group: "Sort" | "Clean up" | "Case" | "Indentation" | "Move";
  /** The edits as one transaction spec, or null when the tool would change nothing. */
  plan?: (state: EditorState) => TransactionSpec | null;
  /** Tools that are editor commands (move and duplicate) run themselves. */
  command?: (target: Target) => boolean;
}

const changeSpec = (changes: ChangeSpec[]): TransactionSpec | null => (changes.length ? { changes, userEvent: "input.linetool", scrollIntoView: true } : null);
const lines = (f: (l: string[]) => string[], perLine = false) => (s: EditorState) => changeSpec(planBlocks(s, f, perLine));

export const LINE_TOOLS: LineTool[] = [
  { id: "sort-asc", label: "Sort ascending", group: "Sort", plan: lines((l) => sortLines(l, "ascending")) },
  { id: "sort-desc", label: "Sort descending", group: "Sort", plan: lines((l) => sortLines(l, "descending")) },
  { id: "sort-insensitive", label: "Sort ignoring case", group: "Sort", plan: lines((l) => sortLines(l, "insensitive")) },
  { id: "sort-numeric", label: "Sort by number", group: "Sort", plan: lines((l) => sortLines(l, "numeric")) },
  { id: "dedupe", label: "Remove duplicate lines", group: "Clean up", plan: lines(removeDuplicates) },
  { id: "trim", label: "Trim trailing spaces", group: "Clean up", plan: lines(trimTrailing, true) },
  { id: "join", label: "Join lines", group: "Clean up", plan: (s) => changeSpec(planJoin(s)) },
  { id: "upper", label: "UPPER CASE", group: "Case", plan: (s) => changeSpec(planText(s, (t) => t.toUpperCase())) },
  { id: "lower", label: "lower case", group: "Case", plan: (s) => changeSpec(planText(s, (t) => t.toLowerCase())) },
  { id: "title", label: "Title Case", group: "Case", plan: (s) => changeSpec(planText(s, titleCase)) },
  { id: "tabs-to-spaces", label: "Tabs to spaces", group: "Indentation", plan: (s) => changeSpec(planBlocks(s, (l) => tabsToSpaces(l, s.tabSize), true)) },
  { id: "spaces-to-tabs", label: "Indentation spaces to tabs", group: "Indentation", plan: (s) => changeSpec(planBlocks(s, (l) => spacesToTabs(l, s.tabSize), true)) },
  { id: "duplicate", label: "Duplicate line", group: "Move", command: (t) => copyLineDown(t) },
  { id: "move-up", label: "Move line up", group: "Move", command: (t) => moveLineUp(t) },
  { id: "move-down", label: "Move line down", group: "Move", command: (t) => moveLineDown(t) },
];

/** Run a tool on the editor as one transaction. False when the editor is read-only or nothing would change. */
export function runLineTool(target: Target, tool: LineTool): boolean {
  if (target.state.readOnly) return false;
  if (tool.command) return tool.command(target);
  const spec = tool.plan?.(target.state);
  if (!spec) return false;
  target.dispatch(target.state.update(spec));
  return true;
}

export const lineTool = (id: string) => LINE_TOOLS.find((t) => t.id === id);
