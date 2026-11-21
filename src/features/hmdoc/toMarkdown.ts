// A rich page as Markdown (NS-3C). The page is rebuilt as an NS-3B document, with what Markdown cannot hold dropped or
// flattened, and each block is written by NS-3B's `writeBlock` in the default style. The report of what was lost is
// counted by the same walk that builds the document, so it cannot say less than the file does.
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { isFormula, showResult } from "./formulas";
import { DEFAULT_STYLE } from "../rich/markdown";
import { richSchema } from "../rich/schema";
import { writeBlock } from "../rich/toMarkdown";
import type { Meta } from "./envelope";
import { DEFAULT_HIGHLIGHT } from "./palette";
import { attrsOf } from "./schema";
import { inspect } from "./validate";
import { tableSheet } from "./blocks/table/grid";

export type ReportKey =
  | "mergedCells" | "richCells" | "cellBackgrounds" | "columnWidths" | "headerColumns" | "textColours" | "highlightColours"
  | "columns" | "toggles" | "calloutIcons" | "formulas" | "cover" | "width" | "views";

/** What each kind of loss is called in the report, in the order the report lists them. */
export const REPORT_LABELS: Record<ReportKey, string> = {
  mergedCells: "Merged cells (the content is kept in the first cell)",
  richCells: "Cells with more than one paragraph or another kind of block (joined with line breaks)",
  cellBackgrounds: "Cell background colours",
  columnWidths: "Column widths",
  headerColumns: "Header columns (written as ordinary cells)",
  textColours: "Text colours",
  highlightColours: "Highlight colours (written as plain highlights)",
  columns: "Column layouts (written one column after another)",
  toggles: "Toggles (written as folded callouts with the summary as the title)",
  calloutIcons: "Callout icons",
  formulas: "Formulas (written as their values)",
  cover: "Cover image",
  width: "Page width",
  views: "Table sort and filter settings",
};

export interface ReportItem { key: ReportKey; label: string; count: number }

/** How the export treats every node, mark and attribute the rich page has and Markdown pages do not (and the few
 *  Markdown pages have that the export drops), by the report item that counts them. `internal` is bookkeeping that is
 *  not content. A test fails when the schema holds one of these that is not listed here. */
export const CLASSIFIED: Record<string, ReportKey | "internal"> = {
  "node:columns": "columns", "node:column": "columns",
  "node:toggle": "toggles", "node:toggleSummary": "toggles",
  "mark:textColor": "textColours",
  "attr:highlight.color": "highlightColours",
  "attr:callout.icon": "calloutIcons",
  "attr:toggle.open": "toggles",
  "attr:tableCell.colspan": "mergedCells", "attr:tableHeader.colspan": "mergedCells",
  "attr:tableCell.rowspan": "mergedCells", "attr:tableHeader.rowspan": "mergedCells",
  "attr:tableCell.colwidth": "columnWidths", "attr:tableHeader.colwidth": "columnWidths",
  "attr:tableCell.background": "cellBackgrounds", "attr:tableHeader.background": "cellBackgrounds",
  "attr:table.id": "internal",
  // Uses of what both kinds of page have: a header cell below the first row, a formula, a cell of several blocks, and
  // the page's own settings.
  "use:headerColumn": "headerColumns", "use:formula": "formulas", "use:richCell": "richCells",
  "meta:cover": "cover", "meta:width": "width", "meta:views": "views",
};

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: Json[]; text?: string };
type Counts = Record<ReportKey, number>;

const target = richSchema();
/** `attrs` reduced to the ones NS-3B's type of that name has: it writes defaults for the rest. */
function pick(kind: "nodes" | "marks", name: string, attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  const known = Object.keys(attrsOf(target[kind][name]));
  const out = Object.fromEntries(known.filter((k) => k in attrs).map((k) => [k, attrs[k]]));
  return Object.keys(out).length ? out : undefined;
}

class Walk {
  counts: Counts = Object.fromEntries(Object.keys(REPORT_LABELS).map((k) => [k, 0])) as Counts;

  marks(marks: readonly Mark[]): Json[] {
    const out: Json[] = [];
    for (const m of marks) {
      if (m.type.name === "textColor") { this.counts.textColours++; continue; }
      if (m.type.name === "highlight" && m.attrs.color !== DEFAULT_HIGHLIGHT) this.counts.highlightColours++;
      out.push({ type: m.type.name, attrs: pick("marks", m.type.name, m.attrs) });
    }
    return out;
  }

  /** The inline content of a text block. */
  inline(block: PMNode): Json[] {
    const out: Json[] = [];
    block.forEach((n) => {
      if (n.isText) out.push({ type: "text", text: n.text, marks: this.marks(n.marks) });
      else out.push({ type: n.type.name, attrs: pick("nodes", n.type.name, n.attrs), marks: this.marks(n.marks) });
    });
    return out;
  }

  /** A block as the NS-3B blocks it becomes: usually one, none or several for the layouts that are flattened. */
  block(n: PMNode): Json[] {
    const name = n.type.name;
    switch (name) {
      case "columns":
        this.counts.columns++;
        return this.children(n);
      case "column": return this.children(n);
      case "toggle": {
        this.counts.toggles++;
        const [summary, ...body] = this.childList(n);
        return [this.callout("[!note]-", summary, body)];
      }
      case "callout": {
        if (n.attrs.icon) this.counts.calloutIcons++;
        const [title, ...body] = this.childList(n);
        return [this.callout(n.attrs.marker, title, body)];
      }
      case "table": return [this.table(n)];
      case "paragraph": case "heading": case "codeBlock":
        return [{ type: name, attrs: pick("nodes", name, n.attrs), content: n.isTextblock ? this.inline(n) : undefined }];
      case "horizontalRule": case "mathBlock": case "rawBlock":
        return [{ type: name, attrs: pick("nodes", name, n.attrs) }];
      default:
        // Lists, quotes, footnote definitions and their items keep their structure.
        return [{ type: name, attrs: pick("nodes", name, n.attrs), content: this.children(n) }];
    }
  }

  /** A callout as Obsidian writes one: the first paragraph of the body follows the title on the next line. */
  private callout(marker: string, title: PMNode, body: PMNode[]): Json {
    const joined = body[0]?.type.name === "paragraph" && body[0].childCount > 0;
    return { type: "callout", attrs: { marker, joined }, content: [{ type: "calloutTitle", content: this.inline(title) }, ...body.flatMap((b) => this.block(b))] };
  }

  private childList(n: PMNode): PMNode[] {
    const out: PMNode[] = [];
    n.forEach((c) => out.push(c));
    return out;
  }

  private children(n: PMNode): Json[] {
    return this.childList(n).flatMap((c) => this.block(c));
  }

  /** What a cell becomes: one paragraph whose lines are the cell's blocks, joined with `<br>`. */
  private cellInline(cell: PMNode): Json[][] {
    const lines: Json[][] = [];
    const take = (n: PMNode) => {
      if (n.isTextblock) {
        // A line break inside a block is a line break in the cell, written as <br> like the break between blocks.
        const inline = n.type.name === "codeBlock" ? [{ type: "text", text: n.textContent, marks: [{ type: "code" }] }]
          : this.inline(n).map((i): Json => (i.type === "hardBreak" ? { type: "rawInline", attrs: { value: "<br>", kind: "html" } } : i));
        if (n.content.size) lines.push(inline);
      } else if (n.type.name === "mathBlock" || n.type.name === "rawBlock") {
        const text = String(n.attrs.value).trim();
        if (text) lines.push([{ type: "text", text }]);
      } else if (n.type.name === "table") {
        // A table in a cell is written once, and what that gives is both the cell's text and what the report counts: its
        // formulas are values, its merged cells and the rest are counted (R2-2). Each of its cells is a line.
        for (const row of (this.table(n).content ?? [])) {
          for (const c of row.content ?? []) {
            const inline = c.content?.[0]?.content ?? [];
            if (inline.length) lines.push(inline);
          }
        }
      } else {
        // What a block of its own would count, counted here too: the layouts and icons nested in a cell are lost as well
        // (R1-13).
        if (n.type.name === "columns") this.counts.columns++;
        else if (n.type.name === "toggle") this.counts.toggles++;
        else if (n.type.name === "callout" && n.attrs.icon) this.counts.calloutIcons++;
        n.forEach(take);
      }
    };
    cell.forEach(take);
    return lines;
  }

  private table(table: PMNode): Json {
    const { grid, sheet } = tableSheet(table);
    const widths = new Set<number>();
    const rows: Json[] = [];
    for (let r = 0; r < grid.rows; r++) {
      const cells: Json[] = [];
      for (let c = 0; c < grid.cols; c++) {
        const [or, oc] = grid.origin(r, c);
        let content: Json[] = [];
        if (or === r && oc === c) {
          const { node: cell } = grid.cell(r, c);
          const a = cell.attrs;
          if ((a.colspan ?? 1) > 1 || (a.rowspan ?? 1) > 1) this.counts.mergedCells++;
          if (a.background) this.counts.cellBackgrounds++;
          (a.colwidth as number[] | null)?.forEach((w, j) => { if (w) widths.add(c + j); });
          const formula = isFormula(cell.textContent) ? sheet.at(r, c) : null;
          if (formula) {
            this.counts.formulas++;
            content = [{ type: "text", text: showResult(formula) }];
          } else {
            // More than one paragraph, or a block that is not a paragraph (an empty paragraph holds nothing).
            let held = 0, other = false;
            cell.forEach((b) => { if (b.type.name === "paragraph" && !b.content.size) return; held++; if (b.type.name !== "paragraph") other = true; });
            if (held > 1 || other) this.counts.richCells++;
            const lines = this.cellInline(cell);
            lines.forEach((line, i) => { if (i) content.push({ type: "rawInline", attrs: { value: "<br>", kind: "html" } }); content.push(...line); });
          }
        }
        cells.push({ type: r === 0 ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content }] });
      }
      rows.push({ type: "tableRow", content: cells });
    }
    this.counts.columnWidths += widths.size;
    // A header column: every cell below the first row in that column is a header cell.
    for (let c = 0; c < grid.cols && grid.rows > 1; c++) {
      let all = true;
      for (let r = 1; r < grid.rows && all; r++) all = grid.cell(r, c).node.type.name === "tableHeader";
      if (all) this.counts.headerColumns++;
    }
    return { type: "table", attrs: pick("nodes", "table", table.attrs), content: rows };
  }
}

/** The link and footnote definitions of a page, as NS-3B's writer wants them, so references read back as references. */
function definitions(doc: PMNode): string[] {
  const out = new Set<string>();
  doc.descendants((n) => {
    if (n.type.name === "rawBlock" && n.attrs.kind === "definition") {
      const label = /^\s*\[([^\]]+)\]:/.exec(String(n.attrs.value))?.[1];
      if (label) out.add(`[${label}]: <>`);
    }
    if (n.type.name === "footnoteDef") out.add(`[^${n.attrs.label ?? n.attrs.identifier}]: x`);
    return true;
  });
  return [...out];
}

/** The Markdown of a rich page, and what it could not keep. */
export function exportMarkdown(doc: PMNode, meta: Meta = {}): { text: string; report: ReportItem[] } {
  const walk = new Walk();
  const blocks: Json[] = [];
  doc.forEach((b) => blocks.push(...walk.block(b)));
  const defs = definitions(doc);
  const parts: string[] = [];
  for (const json of blocks) {
    const node = target.nodeFromJSON(json);
    node.check();
    const text = writeBlock(node, DEFAULT_STYLE, defs);
    if (text) parts.push(text);
  }
  if (meta.cover) walk.counts.cover = 1;
  if (meta.width && meta.width !== "normal") walk.counts.width = 1;
  const ids = new Set<string>();
  doc.descendants((n) => { if (n.type.name === "table" && n.attrs.id) ids.add(n.attrs.id); return true; });
  walk.counts.views = Object.entries(meta.views ?? {}).filter(([id, v]) => ids.has(id) && (v.sort || v.filter)).length;
  const report = (Object.keys(REPORT_LABELS) as ReportKey[]).filter((k) => walk.counts[k] > 0).map((key) => ({ key, label: REPORT_LABELS[key], count: walk.counts[key] }));
  return { text: parts.length ? `${parts.join("\n\n")}\n` : "", report };
}

/** The Markdown for a `.hmdoc` file's text, or why it cannot be exported (the file is not one the editor can hold). */
export function exportText(text: string): { ok: true; markdown: string; report: ReportItem[] } | { ok: false; reason: string } {
  const read = inspect(text);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { text: markdown, report } = exportMarkdown(read.doc, read.envelope.meta);
  return { ok: true, markdown, report };
}
