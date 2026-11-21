// A table as the reader sees it (NS-3C): the visual grid from `TableMap`, in which a merged cell covers several
// positions, and the sort and filter that decide which rows a view shows. Nothing here changes the table.
import type { Node as PMNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import type { FilterOp, TableView } from "../../envelope";
import { plainNumber, Sheet, showResult, type Grid } from "../../formulas";

export interface TableGrid extends Grid {
  map: TableMap;
  /** The cell node covering (row, col), and where it starts in the table's content. */
  cell(row: number, col: number): { node: PMNode; pos: number };
}

/** The visual grid of a table. */
export function tableGrid(table: PMNode): TableGrid {
  const map = TableMap.get(table);
  const origins = new Map<number, [number, number]>();
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const pos = map.map[r * map.width + c];
      if (!origins.has(pos)) origins.set(pos, [r, c]);
    }
  }
  const posAt = (r: number, c: number) => map.map[r * map.width + c];
  return {
    map, rows: map.height, cols: map.width,
    origin: (r, c) => origins.get(posAt(r, c)) ?? [r, c],
    cell: (r, c) => ({ node: table.nodeAt(posAt(r, c))!, pos: posAt(r, c) }),
    text: (r, c) => { const n = table.nodeAt(posAt(r, c)); return n ? n.textBetween(0, n.content.size, " ") : ""; },
  };
}

const sheets = new WeakMap<PMNode, { grid: TableGrid; sheet: Sheet }>();

/** The table's grid and its formulas' values, kept for as long as the table node is the same. */
export function tableSheet(table: PMNode): { grid: TableGrid; sheet: Sheet } {
  let hit = sheets.get(table);
  if (!hit) {
    const grid = tableGrid(table);
    hit = { grid, sheet: new Sheet(grid) };
    sheets.set(table, hit);
  }
  return hit;
}

/** What the cell at (row, col) shows: a formula's value, else its text. */
export function shownText(g: { grid: TableGrid; sheet: Sheet }, row: number, col: number): string {
  const r = g.sheet.at(row, col);
  if (r) return showResult(r);
  const [or, oc] = g.grid.origin(row, col);
  return g.grid.text(or, oc);
}

/** The first row is a header row when every cell in it is a header cell. */
export function hasHeaderRow(table: PMNode): boolean {
  const row = table.firstChild;
  if (!row || !row.childCount) return false;
  for (let i = 0; i < row.childCount; i++) if (row.child(i).type.name !== "tableHeader") return false;
  return true;
}

/** Whether a cell spans rows: a sorted copy of such a table would split it. */
export function hasRowSpans(table: PMNode): boolean {
  let found = false;
  table.descendants((n) => {
    if (n.type.name === "tableCell" || n.type.name === "tableHeader") { if ((n.attrs.rowspan ?? 1) > 1) found = true; return false; }
    return !found;
  });
  return found;
}

/** The sort that applies to `table`, if any: its column is in the table and no cell spans rows. */
export function effectiveSort(table: PMNode, view: TableView | undefined): TableView["sort"] | null {
  if (!view?.sort) return null;
  const map = TableMap.get(table);
  return view.sort.column < map.width && !hasRowSpans(table) ? view.sort : null;
}

/** The filter that applies to `table`, if any. Like a sort it is not applied to a table with a cell that spans rows: hiding
 *  a row there would hide part of the spanning cell and shift the columns of the rows after it (R1-7). */
export function effectiveFilter(table: PMNode, view: TableView | undefined): TableView["filter"] | null {
  if (!view?.filter) return null;
  return view.filter.column < TableMap.get(table).width && !hasRowSpans(table) ? view.filter : null;
}

/** Whether `text` passes a filter. Numbers compare as numbers, everything else as lower-case text. */
export function matches(text: string, op: FilterOp, value: string): boolean {
  const t = text.trim();
  switch (op) {
    case "empty": return t === "";
    case "filled": return t !== "";
    case "contains": return t.toLowerCase().includes(value.trim().toLowerCase());
    case "equals": {
      const a = plainNumber(t), b = plainNumber(value);
      return a !== null && b !== null ? a === b : t.toLowerCase() === value.trim().toLowerCase();
    }
    case "greater": case "less": {
      const a = plainNumber(t), b = plainNumber(value);
      if (a === null || b === null) return false;
      return op === "greater" ? a > b : a < b;
    }
  }
}

/** The body rows (all but a header row) that a view shows, in the order it shows them: sorted when the view has a sort
 *  that applies, in stored order otherwise. The stored table is never reordered. */
export function visibleRows(table: PMNode, view: TableView | undefined): number[] {
  const g = tableSheet(table);
  const first = hasHeaderRow(table) ? 1 : 0;
  let rows = Array.from({ length: g.grid.rows - first }, (_, i) => i + first);
  const filter = effectiveFilter(table, view);
  if (filter) rows = rows.filter((r) => matches(shownText(g, r, filter.column), filter.op, filter.value));
  const sort = effectiveSort(table, view);
  if (sort) {
    const key = (r: number) => shownText(g, r, sort.column).trim();
    const sign = sort.dir === "asc" ? 1 : -1;
    // Blank cells go last either way; numbers come before text.
    rows = rows.map((r, i) => ({ r, i, k: key(r) })).sort((a, b) => {
      if (!a.k || !b.k) return a.k === b.k ? a.i - b.i : a.k ? -1 : 1;
      const x = plainNumber(a.k), y = plainNumber(b.k);
      const order = x !== null && y !== null ? x - y : x !== null ? -1 : y !== null ? 1 : a.k.localeCompare(b.k, undefined, { numeric: true, sensitivity: "base" });
      return order * ((x !== null) === (y !== null) ? sign : 1) || a.i - b.i;
    }).map((o) => o.r);
  }
  return rows;
}
