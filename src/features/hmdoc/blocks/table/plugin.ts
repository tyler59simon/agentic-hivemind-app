// What a table shows beyond its stored cells (NS-3C), drawn as decorations so the document never changes for them:
// formula cells show their value while the cursor is elsewhere, a filter hides the rows that do not match, and a sorted
// table is drawn as a sorted, read-only copy with the stored table hidden. `meta.views` of the page holds the sort and
// filter; the stored rows are never reordered.
import { Extension } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { TableView } from "../../envelope";
import { columnLabel, isFormula, showResult } from "../../formulas";
import { effectiveFilter, effectiveSort, hasHeaderRow, tableSheet, visibleRows } from "./grid";

type Views = Record<string, TableView>;
interface ViewsState { views: Views; deco: DecorationSet; active: number }

export const tableViewKey = new PluginKey<ViewsState>("hmdocTableViews");

/** What the page gives the plugin to draw and control a sorted table's copy. */
export interface CopyHost {
  /** Draw a document holding one table, read-only, the way the page draws it (pictures, links, math and the rest). */
  render(doc: PMNode): { dom: HTMLElement; destroy(): void };
  /** Take the sort off the table with this id. */
  clearSort(id: string): void;
  /** Open the sort and filter dialog of the table with this id. */
  openView(id: string): void;
}

/** The copy drawn as plain HTML, for a page that gives no host. */
const plainHost: Pick<CopyHost, "render"> = {
  render: (doc) => {
    const holder = document.createElement("div");
    holder.append(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
    return { dom: holder, destroy() {} };
  },
};

/** The position of the table cell holding the selection's head, or -1. */
function activeCell(state: EditorState): number {
  const { $head } = state.selection;
  for (let d = $head.depth; d > 0; d--) {
    const name = $head.node(d).type.name;
    if (name === "tableCell" || name === "tableHeader") return $head.before(d);
  }
  return -1;
}

let serial = 0;
const serials = new WeakMap<PMNode, number>();
const serialOf = (n: PMNode) => { let s = serials.get(n); if (!s) { s = ++serial; serials.set(n, s); } return s; };

/** The table with its rows in the order the view gives: the header row, then the rows that pass the filter. A formula
 *  cell holds its value, worked out on the stored table, so the copy shows what the table shows. */
function copyOf(table: PMNode, view: TableView): PMNode {
  const g = tableSheet(table);
  const { schema } = table.type;
  const rows: PMNode[] = [];
  const take = (index: number) => {
    const row = table.child(index);
    const cells: PMNode[] = [];
    let col = 0;
    row.forEach((cell) => {
      const result = isFormula(cell.textContent) ? g.sheet.at(index, col) : null;
      cells.push(result ? cell.type.create(cell.attrs, schema.nodes.paragraph.create(null, schema.text(showResult(result)))) : cell);
      // No cell spans rows in a sorted table, so a cell starts at the columns the cells before it use up.
      col += cell.attrs.colspan ?? 1;
    });
    rows.push(row.type.create(row.attrs, cells));
  };
  if (hasHeaderRow(table)) take(0);
  for (const r of visibleRows(table, view)) take(r);
  return table.type.create(table.attrs, rows);
}

/** Where the drawn copies are ended when ProseMirror drops them. */
const ending = new WeakMap<Node, () => void>();

/** The sorted copy of a table, with its note and the controls that work wherever the selection is. */
function sortedCopy(table: PMNode, view: TableView, host: Partial<CopyHost> & Pick<CopyHost, "render">): HTMLElement {
  const id = table.attrs.id as string;
  const box = document.createElement("div");
  box.className = "hm-sorted";
  box.contentEditable = "false";
  const bar = document.createElement("div");
  bar.className = "hm-sorted-bar";
  const note = document.createElement("span");
  note.className = "hm-sorted-note";
  note.textContent = `Sorted by column ${columnLabel(view.sort!.column)}. Clear the sort to edit.`;
  bar.append(note);
  const button = (label: string, run: (() => void) | undefined) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => run?.());
    bar.append(b);
  };
  button("Clear sort", host.clearSort && (() => host.clearSort!(id)));
  button("Sort and filter…", host.openView && (() => host.openView!(id)));
  const drawn = host.render(table.type.schema.topNodeType.create(null, copyOf(table, view)));
  box.append(bar, drawn.dom);
  ending.set(box, drawn.destroy);
  return box;
}

function build(doc: PMNode, views: Views, active: number, host: Partial<CopyHost> & Pick<CopyHost, "render">): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((table, pos) => {
    // Only blocks can hold a table: text and atoms are not searched.
    if (table.isTextblock || table.isAtom) return false;
    if (table.type.name !== "table") return true;
    const view = views[table.attrs.id as string];
    const g = tableSheet(table);
    const sort = effectiveSort(table, view);
    const filter = effectiveFilter(table, view);
    if (sort) {
      decos.push(Decoration.node(pos, pos + table.nodeSize, { class: "hm-table-hidden" }));
      const shown: TableView = { sort, filter: filter ?? undefined };
      decos.push(Decoration.widget(pos + table.nodeSize, () => sortedCopy(table, shown, host), {
        side: -1, key: `sorted:${serialOf(table)}:${JSON.stringify(shown)}`, ignoreSelection: true, stopEvent: () => true,
        destroy: (node) => ending.get(node)?.(),
      }));
      return true;
    }
    if (filter) {
      const first = hasHeaderRow(table) ? 1 : 0;
      const shown = new Set(visibleRows(table, { filter }));
      let at = pos + 1;
      table.forEach((row, _o, i) => {
        if (i >= first && !shown.has(i)) decos.push(Decoration.node(at, at + row.nodeSize, { class: "hm-row-hidden" }));
        at += row.nodeSize;
      });
    }
    for (let r = 0; r < g.grid.rows; r++) {
      for (let c = 0; c < g.grid.cols; c++) {
        const [or, oc] = g.grid.origin(r, c);
        if (or !== r || oc !== c) continue;
        const { node: cell, pos: rel } = g.grid.cell(r, c);
        const at = pos + 1 + rel;
        // The table's alignment of a column, drawn on each cell that starts in it (UI-3).
        const align = (table.attrs.align as (string | null)[] | null | undefined)?.[c];
        if (align === "left" || align === "center" || align === "right") decos.push(Decoration.node(at, at + cell.nodeSize, { class: `hm-align-${align}` }));
        const text = cell.textContent;
        if (!isFormula(text)) continue;
        if (at === active) continue;
        const result = g.sheet.at(r, c)!;
        const shown = showResult(result);
        let inner = -1;
        cell.descendants((n, p) => { if (inner < 0 && n.isTextblock) inner = p; return inner < 0; });
        if (inner < 0) continue;
        const start = at + 1 + inner + 1;
        decos.push(Decoration.inline(at + 1, at + cell.nodeSize - 1, { class: "hm-formula-src" }));
        decos.push(Decoration.widget(start, (view: EditorView, getPos) => {
          const span = document.createElement("span");
          span.className = `hm-formula${"error" in result ? " hm-formula-error" : ""}`;
          span.contentEditable = "false";
          span.title = text;
          span.textContent = shown;
          // A click on the value opens the formula for editing.
          span.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const p = getPos();
            if (p === undefined) return;
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p), 1)));
            view.focus();
          });
          return span;
        }, { side: -1, key: `f:${at}:${shown}:${text}`, ignoreSelection: true }));
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

/** The ranges of the document a step changes, as `[from, to, wholeIsFine]`. A step that replaces content says so in its
 *  map; one that changes a mark or an attribute (which has no map) says it in its own fields (R1-9). Taking the whole
 *  table away is fine; a mark or attribute set on what is inside it is not. */
function rangesOf(step: Step): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  step.getMap().forEach((from, to) => out.push([from, to, true]));
  if (out.length) return out;
  const s = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
  if (typeof s.from === "number" && typeof s.to === "number") out.push([s.from, s.to, false]);
  // A node's own mark or attribute: the node at `pos`, so only what is inside a table counts, not the table itself.
  else if (typeof s.pos === "number") out.push([s.pos, s.pos, false]);
  return out;
}

/** Whether `tr` changes the inside of a table that is drawn sorted. An edit that begins or ends inside it does; one that
 *  takes the whole table (deleting or replacing it) does not. */
function editsSortedTable(tr: Transaction, state: EditorState): boolean {
  const views = tableViewKey.getState(state)?.views;
  if (!views || !Object.keys(views).length) return false;
  for (let i = 0; i < tr.steps.length; i++) {
    const doc = tr.docs[i];
    for (const [from, to, wholeIsFine] of rangesOf(tr.steps[i])) {
      for (const at of [from, to]) {
        const $at = doc.resolve(Math.min(at, doc.content.size));
        for (let d = $at.depth; d > 0; d--) {
          const node = $at.node(d);
          const whole = wholeIsFine && from <= $at.before(d) && to >= $at.after(d);
          if (node.type.name === "table" && !whole && effectiveSort(node, views[node.attrs.id as string])) return true;
        }
      }
    }
  }
  return false;
}

/** Formula values, filters and sorted copies of the page's tables. `getViews` returns the page's current view state;
 *  a transaction with the plugin's key as meta says it changed. */
export function tableViews(getViews: () => Views, host: Partial<CopyHost> = {}) {
  const drawing = { render: host.render ?? plainHost.render, clearSort: host.clearSort, openView: host.openView };
  return Extension.create({
    name: "hmdocTableViews",
    addProseMirrorPlugins() {
      return [new Plugin<ViewsState>({
        key: tableViewKey,
        state: {
          init: (_c, state) => {
            const views = getViews();
            const active = activeCell(state);
            return { views, active, deco: build(state.doc, views, active, drawing) };
          },
          apply(tr, prev, _old, state) {
            const changed = tr.getMeta(tableViewKey) !== undefined;
            const active = activeCell(state);
            if (!changed && !tr.docChanged && active === prev.active) return prev;
            const views = changed ? getViews() : prev.views;
            return { views, active, deco: build(state.doc, views, active, drawing) };
          },
        },
        props: { decorations: (state) => tableViewKey.getState(state)?.deco },
        filterTransaction: (tr, state) => !(tr.docChanged && editsSortedTable(tr, state)),
      })];
    },
  });
}

/** Tell the plugin the page's views changed. */
export const viewsChanged = (view: EditorView) => view.dispatch(view.state.tr.setMeta(tableViewKey, true).setMeta("addToHistory", false));
