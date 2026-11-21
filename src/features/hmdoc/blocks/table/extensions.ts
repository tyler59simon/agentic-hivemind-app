// Power tables (NS-3C): Tiptap's table with merged cells (`colspan`, `rowspan`), column widths (`colwidth`), a cell
// background from the palette, cells and header cells that hold any blocks, header rows and header columns (cells of
// type `tableHeader`), and an `id` that is the key of the table's view state.
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { isColour } from "../../palette";

/** A cell's background, as a palette name. */
const background = {
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute("data-bg"),
  renderHTML: (attrs: Record<string, unknown>) => (isColour(attrs.background) ? { "data-bg": attrs.background, class: `hm-bg hm-bg-${attrs.background}` } : {}),
};

/** Tiptap's own cell attributes without its per-cell `align` (alignment is the table's, by column), plus a background. */
function cellAttributes(this: { parent?: () => Record<string, unknown> }) {
  const { align: _align, ...own } = this.parent?.() ?? {};
  return { ...own, background };
}

export const HmTable = Table.configure({ resizable: true, cellMinWidth: 60 });
export { TableRow as HmTableRow };
export const HmTableCell = TableCell.extend({ addAttributes: cellAttributes });
export const HmTableHeader = TableHeader.extend({ addAttributes: cellAttributes });

const newId = (taken: Set<string>) => {
  for (;;) {
    const id = `t${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
};

/** The tables that need a new id: none yet, or the same as an earlier table (a table copied and pasted). */
export function tableIdFixes(doc: PMNode): { pos: number; node: PMNode; id: string }[] {
  const taken = new Set<string>();
  const fixes: { pos: number; node: PMNode; id: string }[] = [];
  const need: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    const id = node.attrs.id as string | null;
    if (!id || taken.has(id)) need.push({ pos, node });
    else taken.add(id);
    return true;
  });
  for (const { pos, node } of need) {
    const id = newId(taken);
    taken.add(id);
    fixes.push({ pos, node, id });
  }
  return fixes;
}

/** `doc` with every table given an id it lacks. Table nodes keep their size, so the positions stay valid. */
export function withTableIds(doc: PMNode): PMNode {
  const fixes = tableIdFixes(doc);
  if (!fixes.length) return doc;
  const tr = new Transform(doc);
  for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, { ...f.node.attrs, id: f.id });
  return tr.doc;
}

/** A table made in the editor, or pasted from another page, gets its id as it appears. */
export const TableIds = Extension.create({
  name: "tableIds",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("hmdocTableIds"),
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((t) => t.docChanged)) return null;
        const fixes = tableIdFixes(state.doc);
        if (!fixes.length) return null;
        const tr = state.tr;
        for (const f of fixes) tr.setNodeMarkup(f.pos, undefined, { ...f.node.attrs, id: f.id });
        return tr;
      },
    })];
  },
});
