// The Rich editor's toolbar (NS-3B): marks, blocks, and inside a table its row, column and alignment commands. Buttons
// act on mouse down and leave the focus in the page, as Live's toolbar does.
import type { Editor } from "@tiptap/core";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code, Columns2, Heading1, Heading2, Heading3, Highlighter, Image, Italic, Link,
  List, ListOrdered, ListTodo, MessageSquareText, Minus, Quote, Rows2, Sigma, SquareCode, Strikethrough, Table, Trash2,
} from "lucide-react";
import { selectedRect, TableMap } from "@tiptap/pm/tables";
import { useRef, type ReactNode } from "react";
import { pictureExt } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { attachPictures } from "./editing";
import { insertCallout, SLASH_ITEMS, toggleTask } from "./slash";

interface Item { label: string; keys?: string; icon: ReactNode; run: (e: Editor) => unknown; active?: (e: Editor) => boolean }

const mathBlock = SLASH_ITEMS.find((i) => i.label === "Math block")!;

/** The column of the cell holding the selection, and the table's position. */
function cellColumn(editor: Editor): { table: number; col: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if (/^table(Cell|Header)$/.test($from.node(d).type.name)) {
      const row = $from.node(d - 1);
      const col = $from.index(d - 1);
      const tableDepth = d - 2;
      if (row.type.name !== "tableRow" || tableDepth < 0) return null;
      return { table: $from.before(tableDepth), col };
    }
  }
  return null;
}

function align(editor: Editor, to: "left" | "center" | "right") {
  const at = cellColumn(editor);
  if (!at) return;
  const table = editor.state.doc.nodeAt(at.table);
  if (!table) return;
  const width = table.firstChild?.childCount ?? 0;
  const next = Array.from({ length: width }, (_, i) => (table.attrs.align as (string | null)[])[i] ?? null);
  next[at.col] = next[at.col] === to ? null : to;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(at.table, undefined, { ...table.attrs, align: next }));
}

/** Add a column after the selected ones, or delete the selected columns, with the table's alignments moving along in
 *  the same step: `align` is by position (Codex reviews of 2392f6b, R1-10, and b0afec0, R2-5). The columns are the
 *  table commands' own selection rectangle; a command that changed nothing (the last column) leaves `align` (R2-7). */
function column(editor: Editor, add: boolean) {
  let rect: ReturnType<typeof selectedRect>;
  try { rect = selectedRect(editor.state); } catch { return; }
  const start = rect.tableStart - 1;
  const width = rect.map.width;
  editor.chain().focus()[add ? "addColumnAfter" : "deleteColumn"]().command(({ tr }) => {
    const pos = tr.mapping.map(start);
    const table = tr.doc.nodeAt(pos);
    if (!table || table.type.name !== "table") return true;
    // Columns as the table commands count them: a cell spanning two counts twice (Codex review of ad6c5c5, R3-4).
    const now = TableMap.get(table).width;
    if (now === width) return true;
    const next = Array.from({ length: width }, (_, i) => (table.attrs.align as (string | null)[] | null)?.[i] ?? null);
    if (add) next.splice(rect.right, 0, null);
    else next.splice(rect.left, rect.right - rect.left);
    tr.setNodeMarkup(pos, undefined, { ...table.attrs, align: next });
    return true;
  }).run();
}

export function RichToolbar({ editor, ctx, readOnly, onLink, onEdit }: { editor: Editor; ctx: RichContext; readOnly: boolean; onLink: () => void; onEdit: (pos: number) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const items: Item[] = [
    { label: "Bold", keys: "Ctrl+B", icon: <Bold size="1em" />, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
    { label: "Italic", keys: "Ctrl+I", icon: <Italic size="1em" />, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
    { label: "Strikethrough", keys: "Ctrl+Shift+S", icon: <Strikethrough size="1em" />, run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive("strike") },
    { label: "Highlight", keys: "Ctrl+Shift+H", icon: <Highlighter size="1em" />, run: (e) => e.chain().focus().toggleMark("highlight").run(), active: (e) => e.isActive("highlight") },
    { label: "Inline code", keys: "Ctrl+E", icon: <Code size="1em" />, run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive("code") },
    { label: "Link", icon: <Link size="1em" />, run: () => onLink(), active: (e) => e.isActive("link") },
    { label: "Heading 1", keys: "Ctrl+Alt+1", icon: <Heading1 size="1em" />, run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive("heading", { level: 1 }) },
    { label: "Heading 2", keys: "Ctrl+Alt+2", icon: <Heading2 size="1em" />, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
    { label: "Heading 3", keys: "Ctrl+Alt+3", icon: <Heading3 size="1em" />, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive("heading", { level: 3 }) },
    { label: "Bulleted list", keys: "Ctrl+Shift+8", icon: <List size="1em" />, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
    { label: "Numbered list", keys: "Ctrl+Shift+7", icon: <ListOrdered size="1em" />, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
    { label: "Task", icon: <ListTodo size="1em" />, run: (e) => toggleTask(e), active: (e) => e.isActive("taskItem") },
    { label: "Quote", keys: "Ctrl+Shift+B", icon: <Quote size="1em" />, run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
    { label: "Callout", icon: <MessageSquareText size="1em" />, run: (e) => insertCallout(e), active: (e) => e.isActive("callout") },
    { label: "Code block", keys: "Ctrl+Alt+C", icon: <SquareCode size="1em" />, run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive("codeBlock") },
    { label: "Math block", icon: <Sigma size="1em" />, run: (e) => mathBlock.run(e, onEdit) },
    { label: "Table", icon: <Table size="1em" />, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() },
    { label: "Divider", icon: <Minus size="1em" />, run: (e) => e.chain().focus().setHorizontalRule().run() },
  ];
  const tableItems: Item[] = [
    { label: "Add row below", icon: <Rows2 size="1em" />, run: (e) => e.chain().focus().addRowAfter().run() },
    { label: "Add column right", icon: <Columns2 size="1em" />, run: (e) => column(e, true) },
    { label: "Align column left", icon: <AlignLeft size="1em" />, run: (e) => align(e, "left") },
    { label: "Align column center", icon: <AlignCenter size="1em" />, run: (e) => align(e, "center") },
    { label: "Align column right", icon: <AlignRight size="1em" />, run: (e) => align(e, "right") },
    { label: "Delete row", icon: <Rows2 size="1em" className="danger-text" />, run: (e) => e.chain().focus().deleteRow().run() },
    { label: "Delete column", icon: <Columns2 size="1em" className="danger-text" />, run: (e) => column(e, false) },
    { label: "Delete table", icon: <Trash2 size="1em" className="danger-text" />, run: (e) => e.chain().focus().deleteTable().run() },
  ];
  const pick = async (files: FileList | null) => {
    const attach = ctx.attach;
    const pictures = [...(files ?? [])].filter((f) => pictureExt(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name));
    if (!attach || !pictures.length) return;
    await attachPictures(editor, ctx, editor.state.selection.from, pictures.map((f) => f.name), async (i) => attach(new Uint8Array(await pictures[i].arrayBuffer()), pictures[i].name));
    editor.commands.focus();
  };
  const button = (item: Item) => (
    <button key={item.label} type="button" className={`icon-button${item.active?.(editor) ? " active" : ""}`} disabled={readOnly} aria-label={item.label}
      aria-pressed={item.active ? item.active(editor) : undefined} title={item.keys ? `${item.label} (${item.keys})` : item.label}
      onMouseDown={(e) => { e.preventDefault(); if (!readOnly) item.run(editor); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!readOnly) item.run(editor); } }}>
      {item.icon}
    </button>
  );
  const inTable = editor.isActive("table");
  return (
    <div className="md-toolbar rich-toolbar" role="toolbar" aria-label="Formatting">
      {items.map(button)}
      {ctx.attach && (
        <>
          <button type="button" className="icon-button" disabled={readOnly} aria-label="Picture" title="Attach a picture"
            onMouseDown={(e) => { e.preventDefault(); picker.current?.click(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.current?.click(); } }}>
            <Image size="1em" />
          </button>
          <input ref={picker} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const files = e.target.files; void pick(files).finally(() => { e.target.value = ""; }); }} />
        </>
      )}
      {inTable && <span className="rich-toolbar-sep" aria-hidden />}
      {inTable && tableItems.map(button)}
    </div>
  );
}
