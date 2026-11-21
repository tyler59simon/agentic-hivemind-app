// GFM tables as a model the grid edits, and back to text (NS-3A). Cells keep their Markdown source; a pipe inside a
// cell is always written escaped (`\|`), as GFM splits cells on every unescaped pipe, inside code spans too.

export type Align = "left" | "center" | "right" | null;
export interface TableModel { header: string[]; align: Align[]; rows: string[][] }

/** The cells of one table line: split on unescaped pipes, outer pipes dropped, each cell trimmed. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { cell += c + text[i + 1]; i++; continue; }
    if (c === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

const alignOf = (cell: string): Align => {
  const left = cell.startsWith(":"), right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
};

/** A GFM table's text as a model, or null when its second line is not a delimiter row. Body rows are padded or cut
 *  to the header's width, as GFM reads them. */
export function parseTable(text: string): TableModel | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delims = splitRow(lines[1]);
  if (!delims.every((d) => /^:?-+:?$/.test(d)) || delims.length !== header.length) return null;
  const width = header.length;
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l).slice(0, width);
    while (cells.length < width) cells.push("");
    return cells;
  });
  return { header, align: delims.map(alignOf), rows };
}

/** A cell as written: unescaped pipes escaped, line breaks as `<br>`. */
export function escapeCell(cell: string): string {
  let out = "";
  const text = cell.replace(/\r?\n/g, "<br>");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { out += c + text[i + 1]; i++; continue; }
    out += c === "|" ? "\\|" : c;
  }
  return out;
}

/** Display width of a cell, counting wide (East Asian) characters as two, so columns line up in a monospace font. */
function width(text: string): number {
  let n = 0;
  for (const ch of text) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u.test(ch) ? 2 : 1;
  return n;
}

const dashes = (align: Align, w: number) => {
  const n = Math.max(3, w);
  if (align === "center") return `:${"-".repeat(Math.max(1, n - 2))}:`;
  if (align === "right") return `${"-".repeat(Math.max(2, n - 1))}:`;
  if (align === "left") return `:${"-".repeat(Math.max(2, n - 1))}`;
  return "-".repeat(n);
};

const pad = (cell: string, w: number, align: Align) => {
  const gap = Math.max(0, w - width(cell));
  if (align === "right") return " ".repeat(gap) + cell;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + cell + " ".repeat(Math.ceil(gap / 2));
  return cell + " ".repeat(gap);
};

/** The model as GFM text, columns padded to line up, with leading and trailing pipes and no final newline. */
export function writeTable(model: TableModel): string {
  const cols = model.header.length;
  const all = [model.header, ...model.rows].map((r) => Array.from({ length: cols }, (_, i) => escapeCell(r[i] ?? "")));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(3, ...all.map((r) => width(r[i]))));
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, widths[i], model.align[i] ?? null)).join(" | ")} |`;
  const [head, ...body] = all;
  return [line(head), `| ${widths.map((w, i) => dashes(model.align[i] ?? null, w)).join(" | ")} |`, ...body.map(line)].join("\n");
}

// Grid operations. Each returns a new model; `at` is a column or body-row index.
const clone = (m: TableModel): TableModel => ({ header: [...m.header], align: [...m.align], rows: m.rows.map((r) => [...r]) });

export function insertColumn(m: TableModel, at: number): TableModel {
  const n = clone(m);
  n.header.splice(at, 0, "");
  n.align.splice(at, 0, null);
  n.rows.forEach((r) => r.splice(at, 0, ""));
  return n;
}

export function deleteColumn(m: TableModel, at: number): TableModel {
  if (m.header.length <= 1) return m;
  const n = clone(m);
  n.header.splice(at, 1);
  n.align.splice(at, 1);
  n.rows.forEach((r) => r.splice(at, 1));
  return n;
}

export function moveColumn(m: TableModel, at: number, by: -1 | 1): TableModel {
  const to = at + by;
  if (to < 0 || to >= m.header.length) return m;
  const n = clone(m);
  const swap = <T,>(a: T[]) => { [a[at], a[to]] = [a[to], a[at]]; };
  swap(n.header);
  swap(n.align);
  n.rows.forEach(swap);
  return n;
}

export function alignColumn(m: TableModel, at: number, align: Align): TableModel {
  const n = clone(m);
  n.align[at] = align;
  return n;
}

export function insertRow(m: TableModel, at: number): TableModel {
  const n = clone(m);
  n.rows.splice(Math.max(0, Math.min(at, n.rows.length)), 0, n.header.map(() => ""));
  return n;
}

export function deleteRow(m: TableModel, at: number): TableModel {
  const n = clone(m);
  n.rows.splice(at, 1);
  return n;
}

export function moveRow(m: TableModel, at: number, by: -1 | 1): TableModel {
  const to = at + by;
  if (to < 0 || to >= m.rows.length) return m;
  const n = clone(m);
  [n.rows[at], n.rows[to]] = [n.rows[to], n.rows[at]];
  return n;
}

/** Set one cell: row -1 is the header. */
export function setCell(m: TableModel, row: number, col: number, text: string): TableModel {
  const n = clone(m);
  if (row < 0) n.header[col] = text;
  else n.rows[row][col] = text;
  return n;
}

/** A new two-column table for the toolbar and the slash menu. */
export const NEW_TABLE = writeTable({ header: ["Column 1", "Column 2"], align: [null, null], rows: [["", ""]] });
