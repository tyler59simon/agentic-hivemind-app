// What a table shows beyond its stored cells (NS-3C), drawn as decorations so the document never changes for them:
// formula cells show their value while the cursor is elsewhere, a filter hides the rows that do not match, and a sorted
// table is drawn as a sorted, read-only copy with the stored table hidden. `meta.views` of the page holds the sort and
// filter; the stored rows are never reordered.
import { Extension } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { TableView } from "../../envelope";
import { columnLabel, isFormula, showResult } from "../../formulas";
import { effectiveSort, hasHeaderRow, tableSheet, visibleRows } from "./grid";

type Views = Record<string, TableView>;
interface ViewsState { views: Views; deco: DecorationSet; active: number }

export const tableViewKey = new PluginKey<ViewsState>("hmdocTableViews");

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

/** The table drawn in the order its view gives, as plain HTML: header row, then the rows that pass the filter. */
function sortedCopy(table: PMNode, view: TableView): HTMLElement {
  const { sort } = view;
  const g = tableSheet(table);
  const box = document.createElement("div");
  box.className = "hm-sorted";
  box.contentEditable = "false";
  const note = document.createElement("p");
  note.className = "hm-sorted-note";
  note.textContent = `Sorted by column ${columnLabel(sort!.column)}. Clear the sort to edit.`;
  const el = document.createElement("table");
  const body = document.createElement("tbody");
  const serializer = DOMSerializer.fromSchema(table.type.schema);
  const draw = (rowIndex: number) => {
    const row = table.child(rowIndex);
    const tr = serializer.serializeNode(row) as HTMLElement;
    // No cell spans rows in a sorted table, so a cell starts at the columns the cells before it use up. A formula cell
    // shows its value, as in the table itself.
    let col = 0;
    row.forEach((cell, _o, i) => {
      const result = isFormula(cell.textContent) ? g.sheet.at(rowIndex, col) : null;
      if (result) tr.children[i].textContent = showResult(result);
      col += cell.attrs.colspan ?? 1;
    });
    body.append(tr);
  };
  if (hasHeaderRow(table)) draw(0);
  for (const r of visibleRows(table, view)) draw(r);
  el.append(body);
  box.append(note, el);
  return box;
}

function build(doc: PMNode, views: Views, active: number): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((table, pos) => {
    // Only blocks can hold a table: text and atoms are not searched.
    if (table.isTextblock || table.isAtom) return false;
    if (table.type.name !== "table") return true;
    const view = views[table.attrs.id as string];
    const g = tableSheet(table);
    const sort = effectiveSort(table, view);
    if (sort) {
      decos.push(Decoration.node(pos, pos + table.nodeSize, { class: "hm-table-hidden" }));
      const shown: TableView = { sort, filter: view?.filter };
      decos.push(Decoration.widget(pos + table.nodeSize, () => sortedCopy(table, shown), { side: -1, key: `sorted:${serialOf(table)}:${JSON.stringify(shown)}`, ignoreSelection: true, stopEvent: () => true }));
      return true;
    }
    if (view?.filter) {
      const first = hasHeaderRow(table) ? 1 : 0;
      const shown = new Set(visibleRows(table, { filter: view.filter }));
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
        const text = cell.textContent;
        if (!isFormula(text)) continue;
        const at = pos + 1 + rel;
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

/** Whether `tr` changes the inside of a table that is drawn sorted. An edit that begins or ends inside it does; one that
 *  takes the whole table (deleting or replacing it) does not. */
function editsSortedTable(tr: Transaction, state: EditorState): boolean {
  const views = tableViewKey.getState(state)?.views;
  if (!views || !Object.keys(views).length) return false;
  for (let i = 0; i < tr.steps.length; i++) {
    const doc = tr.docs[i];
    let blocked = false;
    tr.steps[i].getMap().forEach((from, to) => {
      for (const at of [from, to]) {
        const $at = doc.resolve(Math.min(at, doc.content.size));
        for (let d = $at.depth; d > 0 && !blocked; d--) {
          const node = $at.node(d);
          const whole = from <= $at.before(d) && to >= $at.after(d);
          if (node.type.name === "table" && !whole && effectiveSort(node, views[node.attrs.id as string])) blocked = true;
        }
      }
    });
    if (blocked) return true;
  }
  return false;
}

/** Formula values, filters and sorted copies of the page's tables. `getViews` returns the page's current view state;
 *  a transaction with the plugin's key as meta says it changed. */
export function tableViews(getViews: () => Views) {
  return Extension.create({
    name: "hmdocTableViews",
    addProseMirrorPlugins() {
      return [new Plugin<ViewsState>({
        key: tableViewKey,
        state: {
          init: (_c, state) => {
            const views = getViews();
            const active = activeCell(state);
            return { views, active, deco: build(state.doc, views, active) };
          },
          apply(tr, prev, _old, state) {
            const changed = tr.getMeta(tableViewKey) !== undefined;
            const active = activeCell(state);
            if (!changed && !tr.docChanged && active === prev.active) return prev;
            const views = changed ? getViews() : prev.views;
            return { views, active, deco: build(state.doc, views, active) };
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
