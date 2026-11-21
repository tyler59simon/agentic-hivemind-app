// Block commands of the Rich editor (NS-3B), for the slash menu and the toolbar: the same blocks as Live's slash
// menu, built as nodes instead of Markdown text.
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { SlashState } from "./editing";
import { selectAt } from "./views";

export interface BlockCommand { label: string; hint: string; run: (editor: Editor, edit: (pos: number) => void) => void }

/** Insert an atom block in place of the current empty paragraph (or after the current block) and open its editor. */
function insertAtom(editor: Editor, node: PMNode, edit: (pos: number) => void) {
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  let pos: number;
  if (empty) {
    pos = $from.before();
    tr.replaceWith(pos, $from.after(), node);
  } else {
    pos = $from.after(1);
    tr.insert(pos, node);
  }
  editor.view.dispatch(tr);
  selectAt(editor, pos);
  edit(pos);
}

/** Make the current list item a task (or back), starting a list when there is none. */
export function toggleTask(editor: Editor): boolean {
  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      const to = node.type.name === "listItem" ? state.schema.nodes.taskItem : state.schema.nodes.listItem;
      editor.view.dispatch(state.tr.setNodeMarkup($from.before(d), to, to.name === "taskItem" ? { checked: false, spread: node.attrs.spread } : { spread: node.attrs.spread }));
      return true;
    }
  }
  if (!editor.chain().focus().toggleBulletList().run()) return false;
  return toggleTask(editor);
}

export function insertCallout(editor: Editor) {
  const { schema } = editor.state;
  const node = schema.nodes.callout.create({ marker: "[!note]" }, [schema.nodes.calloutTitle.create(), schema.nodes.paragraph.create()]);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  const pos = empty ? $from.before() : $from.after(1);
  if (empty) tr.replaceWith(pos, $from.after(), node);
  else tr.insert(pos, node);
  editor.view.dispatch(tr);
  editor.commands.setTextSelection(pos + 2);
  editor.commands.focus();
}

export const SLASH_ITEMS: BlockCommand[] = [
  { label: "Heading 1", hint: "Ctrl+Alt+1", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", hint: "Ctrl+Alt+2", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", hint: "Ctrl+Alt+3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Bulleted list", hint: "- ", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", hint: "1. ", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Task", hint: "[ ] ", run: (e) => toggleTask(e) },
  { label: "Quote", hint: "> ", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Callout", hint: "[!note]", run: (e) => insertCallout(e) },
  { label: "Table", hint: "3 × 2", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() },
  { label: "Code block", hint: "```", run: (e) => e.chain().focus().setCodeBlock().run() },
  { label: "Mermaid diagram", hint: "```mermaid", run: (e) => e.chain().focus().setCodeBlock({ language: "mermaid" }).insertContent("flowchart LR\n  A --> B").run() },
  { label: "Math block", hint: "$$", run: (e, edit) => insertAtom(e, e.state.schema.nodes.mathBlock.create({ value: "\n\n", closed: true }), edit) },
  { label: "Embed a page", hint: "![[ ]]", run: (e, edit) => {
    const node = e.state.schema.nodes.embed.create({ value: "" });
    const at = e.state.selection.from;
    e.view.dispatch(e.state.tr.replaceSelectionWith(node));
    selectAt(e, at);
    edit(at);
  } },
  { label: "Divider", hint: "---", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

/** Run a slash item: the `/word` goes, then the item runs where it was. */
export function runSlash(editor: Editor, slash: SlashState, item: BlockCommand, edit: (pos: number) => void) {
  editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
  item.run(editor, edit);
}
