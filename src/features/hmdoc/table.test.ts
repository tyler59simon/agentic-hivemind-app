// @vitest-environment jsdom
// NS-3C: power tables. Merged cells, header rows and columns, formulas on the visual grid, ids, and sort and filter as view
// state that never touches the stored rows.
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection, columnResizingPluginKey, TableMap } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";
import { tableSheet, visibleRows, matches, hasRowSpans, effectiveFilter, effectiveSort } from "./blocks/table/grid";
import { tableViews, viewsChanged } from "./blocks/table/plugin";
import { withTableIds } from "./blocks/table/extensions";
import type { TableView } from "./envelope";
import { showCell } from "./formulas";
import { hmdocExtensions, hmdocSchema } from "./schema";
import { readContent } from "./validate";

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const cell = (text: string, attrs?: Record<string, unknown>, type = "tableCell") => ({ type, ...(attrs ? { attrs } : {}), content: [p(text)] });
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const table = (id: string, ...rows: unknown[]) => ({ type: "table", attrs: { id }, content: rows });
const page = (...blocks: unknown[]) => ({ type: "doc", content: blocks });

const editors: Editor[] = [];
function make(content: unknown, views: Record<string, TableView> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const holder = { views };
  const editor = new Editor({ element: el, extensions: [...hmdocExtensions(), tableViews(() => holder.views)], content: content as never });
  editors.push(editor);
  const setViews = (v: Record<string, TableView>) => { holder.views = v; viewsChanged(editor.view); };
  return { editor, el, setViews };
}
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; });

const tableOf = (doc: PMNode) => doc.firstChild!;
/** The position, in the document, of the cell at (row, col) of the first table. */
function cellPos(doc: PMNode, r: number, c: number) {
  const t = tableOf(doc);
  const map = TableMap.get(t);
  return 1 + map.map[r * map.width + c];
}
const rowTexts = (t: PMNode) => { const out: string[] = []; t.forEach((r) => out.push(r.textContent)); return out; };

describe("merged cells", () => {
  const grid3 = () => page(table("t1",
    row(cell("a1", {}, "tableHeader"), cell("b1", {}, "tableHeader"), cell("c1", {}, "tableHeader")),
    row(cell("a2"), cell("b2"), cell("c2")),
    row(cell("a3"), cell("b3"), cell("c3"))));

  it("merges a block of cells into one that spans them, and splits it again", () => {
    const { editor } = make(grid3());
    const doc = editor.state.doc;
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(doc, cellPos(doc, 1, 0), cellPos(doc, 2, 1))));
    expect(editor.commands.mergeCells()).toBe(true);
    const merged = tableOf(editor.state.doc);
    const map = TableMap.get(merged);
    expect(map.width).toBe(3);
    expect(map.height).toBe(3);
    // Four positions, one cell, holding what the four held.
    expect(new Set([map.map[3], map.map[4], map.map[6], map.map[7]]).size).toBe(1);
    const first = merged.nodeAt(map.map[3])!;
    expect(first.attrs).toMatchObject({ colspan: 2, rowspan: 2 });
    expect(first.textContent).toBe("a2b2a3b3");
    expect(map.problems).toBeNull();

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 1, 0) + 2)));
    expect(editor.commands.splitCell()).toBe(true);
    const split = TableMap.get(tableOf(editor.state.doc));
    expect(new Set(split.map).size).toBe(9);
    expect(split.problems).toBeNull();
  });

  const merged = () => page(table("t1",
    row(cell("5", { colspan: 2, rowspan: 2 }), cell("=A1+B2")),
    row(cell("=SUM(A1:B2)")),
    row(cell("1"), cell("2"), cell("=SUM(A1:C2)"))));

  it("formulas read the visual grid: a covered position is the merged cell, a range counts it once", () => {
    const { editor } = make(merged());
    const g = tableSheet(tableOf(editor.state.doc));
    expect(g.grid.rows).toBe(3);
    expect(g.grid.cols).toBe(3);
    expect(showCell(g.sheet, 0, 2)).toBe("10");
    expect(showCell(g.sheet, 1, 2)).toBe("5");
    expect(showCell(g.sheet, 2, 2)).toBe("20");
    // A covered position asks for the merged cell's own formula result, or none.
    expect(showCell(g.sheet, 1, 1)).toBeNull();
    expect(g.grid.origin(1, 1)).toEqual([0, 0]);
  });

  it("a row added inside a merged cell makes it taller, and the formulas follow the new grid", () => {
    const { editor } = make(merged());
    // The cursor in the cell under the merged one's second row.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 1, 2) + 2)));
    expect(editor.commands.addRowBefore()).toBe(true);
    const t = tableOf(editor.state.doc);
    const map = TableMap.get(t);
    expect(map.height).toBe(4);
    expect(t.nodeAt(map.map[0])!.attrs.rowspan).toBe(3);
    expect(map.problems).toBeNull();
    // The last row moved down, and its SUM(A1:C2) reads the merged cell once (5), C1 (10) and the new empty cell.
    const g = tableSheet(t);
    expect(showCell(g.sheet, 3, 2)).toBe("15");
  });

  it("a column deleted beside a merged cell narrows it only when it was inside it", () => {
    const { editor } = make(merged());
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 2, 1) + 2)));
    expect(editor.commands.deleteColumn()).toBe(true);
    const t = tableOf(editor.state.doc);
    const map = TableMap.get(t);
    expect(map.width).toBe(2);
    expect(t.nodeAt(map.map[0])!.attrs.colspan).toBe(1);
    expect(map.problems).toBeNull();
  });

  it("a header row and a header column are cells of the header type, toggled by the table commands", () => {
    const { editor } = make(grid3());
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 1, 1) + 2)));
    expect(editor.commands.toggleHeaderColumn()).toBe(true);
    const t = tableOf(editor.state.doc);
    const types = (r: number) => { const out: string[] = []; t.child(r).forEach((c) => out.push(c.type.name)); return out; };
    expect(types(0)).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(types(1)).toEqual(["tableHeader", "tableCell", "tableCell"]);
    expect(types(2)).toEqual(["tableHeader", "tableCell", "tableCell"]);
    expect(editor.commands.toggleHeaderRow()).toBe(true);
    expect(tableOf(editor.state.doc).child(0).child(1).type.name).toBe("tableCell");
  });

  it("sets a cell's background from the palette, and clears it", () => {
    const { editor } = make(grid3());
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 1, 1) + 2)));
    expect(editor.commands.setCellAttribute("background", "green")).toBe(true);
    const at = (r: number, c: number) => tableOf(editor.state.doc).nodeAt(TableMap.get(tableOf(editor.state.doc)).map[r * 3 + c])!;
    expect(at(1, 1).attrs.background).toBe("green");
    expect(editor.getHTML()).toContain("hm-bg-green");
    editor.commands.setCellAttribute("background", null);
    expect(at(1, 1).attrs.background).toBeNull();
  });
});

describe("column widths", () => {
  it("R1-3: dragging the edge of one column of a merged cell writes widths the validator accepts", () => {
    const { editor } = make(page(table("t1", row(cell("wide", { colspan: 2 })), row(cell("a"), cell("b")))));
    const view = editor.view;
    const at = cellPos(editor.state.doc, 0, 0);
    // The real path: the plugin's handle is on the merged cell, a mouse down starts the drag, and the mouse up ends it.
    view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: at }));
    const plugin = columnResizingPluginKey.get(editor.state)!;
    const down = new MouseEvent("mousedown", { clientX: 100, button: 0 });
    plugin.props.handleDOMEvents!.mousedown!.call(plugin, view, down);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 190 }));
    const merged = tableOf(editor.state.doc).child(0).child(0);
    expect(merged.attrs.colwidth).toHaveLength(2);
    // The column left of the dragged one has no width set: prosemirror-tables writes 0 for it.
    expect(merged.attrs.colwidth).toContain(0);
    const read = readContent(editor.state.doc.toJSON());
    expect(read.ok ? "ok" : read.reason).toBe("ok");
  });
});

describe("table ids", () => {
  it("a table made in the editor gets an id, and two tables never share one", () => {
    const { editor } = make(page(p("x")));
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const ids: string[] = [];
    editor.state.doc.descendants((n) => { if (n.type.name === "table") ids.push(n.attrs.id); return true; });
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => /^t[a-z0-9]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("a table pasted as a copy gets a new id and the original keeps its own", () => {
    const { editor } = make(page(table("t1", row(cell("a")))));
    const copy = editor.state.doc.child(0);
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, copy));
    const ids: string[] = [];
    editor.state.doc.descendants((n) => { if (n.type.name === "table") ids.push(n.attrs.id); return true; });
    expect(ids[0]).toBe("t1");
    expect(ids[1]).not.toBe("t1");
    expect(ids[1]).toBeTruthy();
  });

  it("tables read from a file get ids when the page loads, without a transaction", () => {
    const doc = hmdocSchema().nodeFromJSON(page({ type: "table", content: [row(cell("a"))] }));
    expect(doc.firstChild!.attrs.id).toBeNull();
    expect(withTableIds(doc).firstChild!.attrs.id).toMatch(/^t/);
    expect(withTableIds(doc).firstChild!.attrs.id).not.toBe(withTableIds(doc).firstChild!.attrs.id);
  });
});

describe("sort and filter", () => {
  const data = () => page(
    table("t1",
      row(cell("Name", {}, "tableHeader"), cell("Qty", {}, "tableHeader")),
      row(cell("pear"), cell("2")), row(cell("apple"), cell("10")), row(cell("fig"), cell("")), row(cell("cherry"), cell("1")), row(cell("date"), cell("=B2+B5"))),
    p("after"));

  it("works out the order of the rows a view shows: numbers by value, blanks last, formulas by their value", () => {
    const { editor } = make(data());
    const t = tableOf(editor.state.doc);
    const texts = (rows: number[]) => rows.map((r) => t.child(r).child(0).textContent);
    expect(texts(visibleRows(t, undefined))).toEqual(["pear", "apple", "fig", "cherry", "date"]);
    expect(texts(visibleRows(t, { sort: { column: 1, dir: "asc" } }))).toEqual(["cherry", "pear", "date", "apple", "fig"]);
    expect(texts(visibleRows(t, { sort: { column: 1, dir: "desc" } }))).toEqual(["apple", "date", "pear", "cherry", "fig"]);
    expect(texts(visibleRows(t, { sort: { column: 0, dir: "asc" } }))).toEqual(["apple", "cherry", "date", "fig", "pear"]);
    expect(texts(visibleRows(t, { filter: { column: 0, op: "contains", value: "E" } }))).toEqual(["pear", "apple", "cherry", "date"]);
    expect(texts(visibleRows(t, { filter: { column: 1, op: "greater", value: "1" }, sort: { column: 0, dir: "asc" } }))).toEqual(["apple", "date", "pear"]);
  });

  it("filters by every operator", () => {
    expect(matches("Apple pie", "contains", "pie")).toBe(true);
    expect(matches("10", "equals", "10.0")).toBe(true);
    expect(matches("Fig", "equals", "fig")).toBe(true);
    expect(matches("10", "greater", "9")).toBe(true);
    expect(matches("ten", "greater", "9")).toBe(false);
    expect(matches("2", "less", "9")).toBe(true);
    expect(matches(" ", "empty", "")).toBe(true);
    expect(matches("x", "filled", "")).toBe(true);
  });

  it("a sorted table is drawn as a sorted copy and the stored rows never change", () => {
    const { editor, el, setViews } = make(data());
    const before = JSON.stringify(editor.state.doc.toJSON());
    setViews({ t1: { sort: { column: 1, dir: "asc" } } });
    const names = [...el.querySelectorAll(".hm-sorted tbody tr")].map((tr) => tr.querySelector("td, th")!.textContent);
    expect(names).toEqual(["Name", "cherry", "pear", "date", "apple", "fig"]);
    expect(el.querySelector(".hm-sorted-note")!.textContent).toBe("Sorted by column B. Clear the sort to edit.");
    expect(el.querySelector(".hm-table-hidden")).toBeTruthy();
    // The formula shows its value in the copy too.
    expect(el.querySelector(".hm-sorted")!.textContent).toContain("3");
    expect(JSON.stringify(editor.state.doc.toJSON())).toBe(before);
    // Turning the sort off draws the table as it is stored.
    setViews({});
    expect(el.querySelector(".hm-sorted")).toBeNull();
    expect(el.querySelector(".hm-table-hidden")).toBeNull();
    expect(JSON.stringify(editor.state.doc.toJSON())).toBe(before);
  });

  it("a sorted table takes no edits inside it, and the rest of the page does", () => {
    const { editor, setViews } = make(data());
    setViews({ t1: { sort: { column: 1, dir: "asc" } } });
    const before = editor.state.doc;
    editor.view.dispatch(editor.state.tr.insertText("X", cellPos(editor.state.doc, 1, 0) + 2));
    expect(editor.state.doc).toBe(before);
    // An edit that starts inside the hidden table and ends outside it is an edit of the table too.
    editor.view.dispatch(editor.state.tr.delete(cellPos(editor.state.doc, 1, 0) + 2, editor.state.doc.content.size - 2));
    expect(editor.state.doc).toBe(before);
    editor.view.dispatch(editor.state.tr.insertText("Y", editor.state.doc.content.size - 1));
    expect(editor.state.doc.lastChild!.textContent).toBe("afterY");
    // Taking the whole table is not an edit inside it.
    editor.view.dispatch(editor.state.tr.delete(0, tableOf(editor.state.doc).nodeSize));
    expect(editor.state.doc.childCount).toBe(1);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
    // The sort is still in force after the undo.
    editor.view.dispatch(editor.state.tr.insertText("Z", cellPos(editor.state.doc, 1, 0) + 2));
    expect(rowTexts(tableOf(editor.state.doc))[1]).toBe("pear2");
    setViews({});
    editor.view.dispatch(editor.state.tr.insertText("X", cellPos(editor.state.doc, 1, 0) + 2));
    expect(rowTexts(tableOf(editor.state.doc))[1]).toBe("Xpear2");
  });

  it("a filter hides the rows that do not match, and the table stays editable", () => {
    const { editor, el, setViews } = make(data());
    const before = JSON.stringify(editor.state.doc.toJSON());
    setViews({ t1: { filter: { column: 0, op: "contains", value: "e" } } });
    const hidden = [...el.querySelectorAll("tr.hm-row-hidden")].map((tr) => tr.querySelector("td")!.textContent);
    expect(hidden).toEqual(["fig"]);
    expect(el.querySelector(".hm-sorted")).toBeNull();
    expect(JSON.stringify(editor.state.doc.toJSON())).toBe(before);
    editor.view.dispatch(editor.state.tr.insertText("!", cellPos(editor.state.doc, 1, 0) + 2));
    expect(tableOf(editor.state.doc).child(1).child(0).textContent).toBe("!pear");
    // The header row is never hidden, whatever the filter.
    setViews({ t1: { filter: { column: 0, op: "equals", value: "nothing" } } });
    expect(el.querySelectorAll("tr.hm-row-hidden")).toHaveLength(5);
    expect(el.querySelectorAll("tr").length).toBe(6);
  });

  it("sorting is not offered for a table with a cell that spans rows: the view is kept but not drawn", () => {
    const content = page(table("t1", row(cell("a", { rowspan: 2 }), cell("2")), row(cell("1")), row(cell("b"), cell("0"))));
    const { editor, el, setViews } = make(content);
    const t = tableOf(editor.state.doc);
    expect(hasRowSpans(t)).toBe(true);
    expect(effectiveSort(t, { sort: { column: 1, dir: "asc" } })).toBeNull();
    setViews({ t1: { sort: { column: 1, dir: "asc" } } });
    expect(el.querySelector(".hm-sorted")).toBeNull();
    expect(el.querySelector(".hm-table-hidden")).toBeNull();
  });

  it("R1-7: a filter is not applied to a table with a cell that spans rows, as a sort is not", () => {
    const content = page(table("t1", row(cell("a", { rowspan: 2 }), cell("keep")), row(cell("hide")), row(cell("b"), cell("hide"))));
    const { editor, el, setViews } = make(content);
    const t = tableOf(editor.state.doc);
    expect(effectiveFilter(t, { filter: { column: 1, op: "contains", value: "keep" } })).toBeNull();
    setViews({ t1: { filter: { column: 1, op: "contains", value: "keep" } } });
    expect(el.querySelectorAll("tr.hm-row-hidden")).toHaveLength(0);
    expect(visibleRows(t, { filter: { column: 1, op: "contains", value: "keep" } })).toEqual([0, 1, 2]);
  });

  it("R1-9: a mark or an attribute set inside a sorted table is refused too, though those steps change no content", () => {
    const { editor, setViews } = make(data());
    setViews({ t1: { sort: { column: 1, dir: "asc" } } });
    const before = editor.state.doc;
    const inside = cellPos(editor.state.doc, 1, 0);
    editor.view.dispatch(editor.state.tr.addMark(inside + 1, inside + 5, editor.schema.marks.bold.create()));
    expect(editor.state.doc).toBe(before);
    editor.view.dispatch(editor.state.tr.setNodeAttribute(inside, "background", "red"));
    expect(editor.state.doc).toBe(before);
    editor.view.dispatch(editor.state.tr.addMark(1, editor.state.doc.content.size - 1, editor.schema.marks.bold.create()));
    expect(editor.state.doc).toBe(before);
    // The page outside the table takes marks, and the table takes them again once it is not sorted.
    const after = editor.state.doc.content.size - 6;
    editor.view.dispatch(editor.state.tr.addMark(after, after + 3, editor.schema.marks.bold.create()));
    expect(editor.state.doc.lastChild!.child(0).marks.length || editor.state.doc.lastChild!.child(1)?.marks.length).toBeGreaterThan(0);
    setViews({});
    editor.view.dispatch(editor.state.tr.setNodeAttribute(inside, "background", "red"));
    expect(editor.state.doc.firstChild!.child(1).child(0).attrs.background).toBe("red");
  });

  it("a view of a column the table does not have is not drawn", () => {
    const { editor, el, setViews } = make(data());
    setViews({ t1: { sort: { column: 9, dir: "asc" }, filter: { column: 9, op: "contains", value: "x" } } });
    expect(el.querySelector(".hm-sorted")).toBeNull();
    expect(el.querySelectorAll("tr.hm-row-hidden")).toHaveLength(0);
    expect(editor.state.doc.childCount).toBe(2);
  });
});

describe("formulas in the editor", () => {
  const content = () => page(table("t1", row(cell("2"), cell("3"), cell("=A1+B1")), row(cell("=1/0"), cell("=Z9"), cell("=A2"))));

  it("a formula cell shows its value, and its formula while the cursor is in it", () => {
    const { editor, el } = make(content());
    const shown = () => [...el.querySelectorAll(".hm-formula")].map((s) => s.textContent);
    expect(shown()).toEqual(["5", "#DIV/0!", "#REF!", "#DIV/0!"]);
    expect(el.querySelectorAll(".hm-formula-error")).toHaveLength(3);
    // The stored text is the formula, hidden while the value shows.
    expect(editor.state.doc.firstChild!.child(0).child(2).textContent).toBe("=A1+B1");
    expect(el.querySelectorAll(".hm-formula-src")).toHaveLength(4);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, cellPos(editor.state.doc, 0, 2) + 3)));
    expect(shown()).toEqual(["#DIV/0!", "#REF!", "#DIV/0!"]);
    expect(el.querySelectorAll(".hm-formula-src")).toHaveLength(3);
  });

  it("recalculates when a cell it reads changes", () => {
    const { editor, el } = make(content());
    editor.view.dispatch(editor.state.tr.insertText("10", cellPos(editor.state.doc, 0, 0) + 2, cellPos(editor.state.doc, 0, 0) + 3));
    expect([...el.querySelectorAll(".hm-formula")][0].textContent).toBe("13");
  });
});
