// Two to four columns side by side (NS-3C). Each column holds any blocks; the grid draws as many columns as there are.
import { Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: `column{${MIN_COLUMNS},${MAX_COLUMNS}}`,
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "div[data-columns]" }],
  renderHTML: () => ["div", { "data-columns": "", class: "hm-columns" }, 0],
});

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: "div[data-column]" }],
  renderHTML: () => ["div", { "data-column": "", class: "hm-column" }, 0],
});

/** The `columns` block holding the selection, as its depth. */
function columnsDepth(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "columns") return d;
  return null;
}

/** Columns in place of the empty paragraph holding the cursor, else after the block that holds it. */
export function insertColumns(editor: Editor, count: number): boolean {
  const n = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, count));
  const { schema } = editor.state;
  const node = schema.nodes.columns.create(null, Array.from({ length: n }, () => schema.nodes.column.create(null, schema.nodes.paragraph.create())));
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  const pos = empty ? $from.before() : $from.after();
  if (empty) tr.replaceWith(pos, $from.after(), node);
  else tr.insert(pos, node);
  // The cursor goes into the first column: columns, column, paragraph.
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** A column after the one holding the cursor, while there are fewer than four. */
export function addColumn(editor: Editor): boolean {
  const d = columnsDepth(editor);
  if (d === null) return false;
  const { $from } = editor.state.selection;
  const columns = $from.node(d);
  if (columns.childCount >= MAX_COLUMNS) return false;
  const { schema } = editor.state;
  const at = $from.index(d);
  let pos = $from.start(d);
  for (let i = 0; i <= at; i++) pos += columns.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.insert(pos, schema.nodes.column.create(null, schema.nodes.paragraph.create())));
  return true;
}

const isEmptyColumn = (c: PMNode) => c.childCount === 1 && c.child(0).type.name === "paragraph" && c.child(0).content.size === 0;

/** The column holding the cursor goes while there are more than two. Its blocks join the column before it (or after
 *  it, for the first), so removing a column never deletes what it held. */
export function removeColumn(editor: Editor): boolean {
  const d = columnsDepth(editor);
  if (d === null) return false;
  const { $from } = editor.state.selection;
  const columns = $from.node(d);
  if (columns.childCount <= MIN_COLUMNS) return false;
  const at = $from.index(d);
  const column = columns.child(at);
  const start = $from.start(d);
  let from = start;
  for (let i = 0; i < at; i++) from += columns.child(i).nodeSize;
  const tr = editor.state.tr.delete(from, from + column.nodeSize);
  if (!isEmptyColumn(column)) {
    // Into the end of the previous column, or the start of what is now the first.
    const into = at > 0 ? from - 1 : from + 1;
    tr.insert(into, column.content);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const inColumns = (editor: Editor) => columnsDepth(editor) !== null;
