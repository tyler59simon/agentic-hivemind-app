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
import { rangeLabel } from "./blocks/codeRange";
import { isEmbed } from "./blocks/embeds";
import { frameOrder } from "./blocks/layout";

export type ReportKey =
  | "mergedCells" | "richCells" | "cellBackgrounds" | "columnWidths" | "headerColumns" | "textColours" | "highlightColours"
  | "columns" | "toggles" | "calloutIcons" | "listNumbers" | "formulas" | "cover" | "width" | "views"
  | "noteCards" | "diagrams" | "codeRanges" | "pdfPages" | "galleries" | "drawings" | "freeform";

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
  listNumbers: "List numbering (lists that start below 0 are numbered from 1)",
  formulas: "Formulas (written as their values)",
  cover: "Cover image",
  width: "Page width",
  views: "Table sort and filter settings",
  noteCards: "Memory note cards (written as a line with the note's title and reference)",
  diagrams: "Architecture diagrams (written as a line naming the diagram)",
  codeRanges: "Code ranges (written as a fenced block of the stored lines, with no live view or changed badge)",
  pdfPages: "PDF pages (written as a link to the file and page)",
  galleries: "Galleries (written as their pictures one after another)",
  drawings: "Drawings (written as their preview picture; the scene is not exported)",
  freeform: "Free-positioned blocks (their frames are written one after another, top to bottom, then left to right)",
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
  "node:noteCard": "noteCards", "node:diagram": "diagrams", "node:codeRange": "codeRanges", "node:pdfPage": "pdfPages",
  "node:gallery": "galleries", "node:excalidraw": "drawings", "node:freeform": "freeform", "node:frame": "freeform",
  // Uses of what both kinds of page have: a header cell below the first row, a formula, a cell of several blocks, and
  // the page's own settings.
  "use:negativeListStart": "listNumbers", "use:headerColumn": "headerColumns", "use:formula": "formulas", "use:richCell": "richCells",
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

/** `path`, a path from the notebook's root, as the link a page in `folder` writes for it. */
export function relativeFrom(folder: string, path: string): string {
  const from = folder ? folder.split("/") : [];
  const to = path.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

const plain = (value: string, marks?: Json[]): Json => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const code = (value: string): Json => plain(value, [{ type: "code" }]);
const paragraph = (...content: Json[]): Json => ({ type: "paragraph", content });
const baseName = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]*$/, "");

class Walk {
  constructor(private folder = "") {}
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
      case "freeform": {
        this.counts.freeform++;
        return this.frames(n).flatMap((f) => this.block(f));
      }
      case "frame": return this.children(n);
      case "noteCard": case "diagram": case "codeRange": case "pdfPage": case "gallery": case "excalidraw":
        return this.embed(n);
      case "paragraph": case "heading": case "codeBlock":
        return [{ type: name, attrs: pick("nodes", name, n.attrs), content: n.isTextblock ? this.inline(n) : undefined }];
      case "horizontalRule": case "mathBlock": case "rawBlock":
        return [{ type: name, attrs: pick("nodes", name, n.attrs) }];
      default:
        // Lists, quotes, footnote definitions and their items keep their structure. A list that starts below 0 is written
        // from 1 (R3-2).
        if (name === "orderedList" && (n.attrs.start ?? 1) < 0) this.counts.listNumbers++;
        return [{ type: name, attrs: pick("nodes", name, n.attrs), content: this.children(n) }];
    }
  }

  /** The frames of a free-positioned block in reading order: top to bottom, then left to right. */
  private frames(n: PMNode): PMNode[] {
    const frames = this.childList(n);
    return frameOrder(frames.map((f) => ({ x: f.attrs.x, y: f.attrs.y }))).map((i) => frames[i]);
  }

  /** An embed as the blocks Markdown has for it, counted once. */
  private embed(n: PMNode): Json[] {
    const a = n.attrs;
    const picture = (src: string, alt: string): Json => paragraph({ type: "image", attrs: { src: relativeFrom(this.folder, src), alt, title: null } });
    switch (n.type.name) {
      case "noteCard":
        this.counts.noteCards++;
        return [paragraph(plain(`Memory note: ${a.title || a.ref} (`), code(a.ref), plain(")"))];
      case "diagram":
        this.counts.diagrams++;
        return [paragraph(plain(`Architecture diagram: ${a.title || a.path} (system ${a.system}, `), code(a.path), plain(")"))];
      case "codeRange": {
        this.counts.codeRanges++;
        const lines: Json[] = [paragraph(...(a.title ? [plain(`${a.title}: `)] : []), code(rangeLabel(a.file, a.from, a.to)))];
        const block: Json = { type: "codeBlock", attrs: pick("nodes", "codeBlock", { language: a.language || null }) };
        if (a.text) block.content = [plain(a.text)];
        return [...lines, block];
      }
      case "pdfPage": {
        this.counts.pdfPages++;
        return [paragraph(plain(a.title || `${baseName(a.file)}, page ${a.page}`, [{ type: "link", attrs: { href: `${relativeFrom(this.folder, a.file)}#page=${a.page}`, title: null } }]))];
      }
      case "gallery": {
        this.counts.galleries++;
        const out: Json[] = a.title ? [paragraph(plain(a.title))] : [];
        for (const src of a.images as string[]) out.push(picture(src, baseName(src)));
        return out;
      }
      default:
        this.counts.drawings++;
        return [picture(a.preview, a.title || baseName(a.scene))];
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
      } else if (isEmbed(n.type.name)) {
        // An embed in a cell is the line or lines it would be written as; a code range's stored lines are lines of code.
        for (const b of this.embed(n)) {
          if (b.type === "codeBlock") for (const l of (b.content?.[0]?.text ?? "").split("\n")) lines.push(l ? [code(l)] : []);
          else lines.push(b.content ?? []);
        }
      } else if (n.type.name === "freeform") {
        this.counts.freeform++;
        for (const f of this.frames(n)) f.forEach(take);
      } else {
        // What a block of its own would count, counted here too: the layouts and icons nested in a cell are lost as well
        // (R1-13).
        if (n.type.name === "columns") this.counts.columns++;
        else if (n.type.name === "toggle") this.counts.toggles++;
        else if (n.type.name === "callout" && n.attrs.icon) this.counts.calloutIcons++;
        else if (n.type.name === "orderedList" && (n.attrs.start ?? 1) < 0) this.counts.listNumbers++;
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
            // Appended one by one: a line can hold more nodes than a call may take as arguments (R3-1).
            lines.forEach((line, i) => {
              if (i) content.push({ type: "rawInline", attrs: { value: "<br>", kind: "html" } });
              for (const item of line) content.push(item);
            });
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

/** The Markdown of a rich page, and what it could not keep. `folder` is the folder of the page the Markdown is written
 *  beside, so paths from the notebook's root are written as links from there. */
export function exportMarkdown(doc: PMNode, meta: Meta = {}, folder = ""): { text: string; report: ReportItem[] } {
  const walk = new Walk(folder);
  const blocks: Json[] = [];
  doc.forEach((b) => { for (const json of walk.block(b)) blocks.push(json); });
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
export function exportText(text: string, folder = ""): { ok: true; markdown: string; report: ReportItem[] } | { ok: false; reason: string } {
  const read = inspect(text);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { text: markdown, report } = exportMarkdown(read.doc, read.envelope.meta, folder);
  return { ok: true, markdown, report };
}
