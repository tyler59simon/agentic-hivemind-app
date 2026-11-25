// The pieces the rich page editor (NS-3A) draws in place of Markdown source: pictures, math, Mermaid diagrams,
// embedded pages, callout titles, footnote marks and the table grid. A widget that edits the page finds its source
// again at the time of the edit (`sourceAt`), so a widget kept across edits above it never writes at an old position.
import { StateEffect } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { webImageNote } from "../../../lib/webImage";
import { renderMath } from "../../../ui/Math";
import { diagramClick, drawMermaid, skipReason } from "../../../ui/Mermaid";
import type { RichContext } from "./context";
import { section, withWidth, type Callout } from "./parse";
import * as T from "./tables";

/** Flip a foldable callout open or closed; the value is the start of its first line. */
export const toggleCallout = StateEffect.define<number>();

/** Where a widget's source starts now, or null when the page no longer holds that source there. */
export function sourceAt(view: EditorView, dom: HTMLElement, source: string): number | null {
  let from: number;
  try { from = view.posAtDOM(dom); } catch { return null; }
  return view.state.sliceDoc(from, from + source.length) === source ? from : null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The narrowest and widest a picture may be made, and what one arrow key press changes the width by, in pixels. */
const MIN_PICTURE = 32, MAX_PICTURE = 2000, PICTURE_STEP = 16;

/** A picture: its source replaced by the picture, with a handle that writes the width (`|300`) back. */
export class PictureWidget extends WidgetType {
  /** `src` is the picture's own address, for the note that says a web picture is not shown (REG-30). */
  constructor(readonly source: string, readonly url: string | null, readonly alt: string, readonly width: number | undefined, readonly block: boolean, readonly src = "") { super(); }
  eq(o: PictureWidget) { return o.source === this.source && o.url === this.url && o.block === this.block; }
  get estimatedHeight() { return this.block ? 200 : -1; }
  toDOM(view: EditorView) {
    const box = el(this.block ? "div" : "span", this.block ? "cm-rich-picture cm-rich-block" : "cm-rich-picture");
    const note = webImageNote(this.src);
    const missing = () => { box.replaceChildren(el("span", "cm-rich-missing", `[${this.alt || "picture"}]${note ? ` ${note}` : ""}`)); box.title = this.source; };
    if (!this.url) { missing(); return box; }
    const img = el("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    img.draggable = false;
    if (this.width) img.style.width = `${this.width}px`;
    img.addEventListener("error", missing);
    const handle = el("span", "cm-rich-resize");
    // Without a drag (WCAG 2.5.7): the handle takes focus, and the arrow keys change the width by 16 (as a slider does). The width
    // can also be typed in the source: ![alt|300](picture.png).
    handle.title = "Drag to resize, use the arrow keys when it has focus, or type the width in the source: ![alt|300](picture.png)";
    handle.tabIndex = 0;
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", "Picture width");
    handle.setAttribute("aria-valuemin", String(MIN_PICTURE));
    handle.setAttribute("aria-valuemax", String(MAX_PICTURE));
    handle.dataset.source = this.source;
    const shownWidth = () => Math.round(img.getBoundingClientRect().width || this.width || 0);
    handle.setAttribute("aria-valuenow", String(shownWidth()));
    img.addEventListener("load", () => handle.setAttribute("aria-valuenow", String(shownWidth())));
    handle.addEventListener("keydown", (e) => {
      const by = ({ ArrowRight: PICTURE_STEP, ArrowUp: PICTURE_STEP, ArrowLeft: -PICTURE_STEP, ArrowDown: -PICTURE_STEP } as Record<string, number>)[e.key];
      if (by === undefined || e.ctrlKey || e.metaKey || e.altKey || view.state.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const from = sourceAt(view, box, this.source);
      if (from === null) return;
      const next = withWidth(this.source, Math.min(MAX_PICTURE, Math.max(MIN_PICTURE, shownWidth() + by)));
      view.dispatch({ changes: { from, to: from + this.source.length, insert: next }, userEvent: "input.resize" });
      // The new source draws a new widget; the keyboard goes on to its handle.
      [...view.dom.querySelectorAll<HTMLElement>(".cm-rich-resize")].find((h) => h.dataset.source === next)?.focus({ preventScroll: true });
    });
    handle.addEventListener("pointerdown", (e) => {
      if (view.state.readOnly) return;
      e.preventDefault();
      const startX = e.clientX, startWidth = img.getBoundingClientRect().width;
      const widthAt = (x: number) => Math.max(MIN_PICTURE, Math.round(startWidth + x - startX));
      handle.setPointerCapture?.(e.pointerId);
      const move = (ev: PointerEvent) => { img.style.width = `${widthAt(ev.clientX)}px`; };
      const up = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        const from = sourceAt(view, box, this.source);
        if (from === null) return;
        view.dispatch({ changes: { from, to: from + this.source.length, insert: withWidth(this.source, widthAt(ev.clientX)) }, userEvent: "input.resize" });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    box.append(img, handle);
    return box;
  }
  // A click on the picture puts the cursor there, which shows its source; the handle is the widget's own.
  ignoreEvent(e: Event) { return !!(e.target as Element).closest?.(".cm-rich-resize"); }
}

/** `$...$` or a `$$` block, drawn by KaTeX. */
export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) { super(); }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display; }
  get estimatedHeight() { return this.display ? 48 : -1; }
  toDOM() {
    const box = el(this.display ? "div" : "span", this.display ? "cm-rich-math cm-rich-block" : "cm-rich-math");
    void renderMath(box, this.tex, this.display);
    return box;
  }
  ignoreEvent() { return false; }
}

/** A ```mermaid fence, drawn as a diagram; its source shows until it has drawn and when it cannot be drawn. */
export class MermaidWidget extends WidgetType {
  constructor(readonly source: string, readonly dark: boolean) { super(); }
  eq(o: MermaidWidget) { return o.source === this.source && o.dark === this.dark; }
  get estimatedHeight() { return 240; }
  toDOM() {
    const box = el("div", "cm-rich-mermaid cm-rich-block");
    box.append(el("pre", "cm-rich-mermaid-source", this.source));
    const note = (text: string) => box.append(el("p", "muted", text));
    const skip = skipReason(this.source);
    if (skip) note(skip);
    else {
      drawMermaid(this.source, this.dark).then(
        (svg) => { box.innerHTML = svg; },
        () => note("Diagram did not render."),
      );
    }
    box.addEventListener("click", diagramClick, true);
    return box;
  }
  ignoreEvent() { return false; }
}

const embedCleanup = new WeakMap<HTMLElement, () => void>();

/** `![[Page]]` or `![[Page#Heading]]`: the page drawn read-only, with a button that opens it. */
export class EmbedWidget extends WidgetType {
  constructor(readonly target: string, readonly heading: string | undefined, readonly ctx: RichContext, readonly stamp: number) { super(); }
  eq(o: EmbedWidget) { return o.target === this.target && o.heading === this.heading && o.stamp === this.stamp; }
  get estimatedHeight() { return 160; }
  toDOM() {
    const box = el("div", "cm-rich-embed cm-rich-block");
    const head = el("div", "cm-rich-embed-head");
    const name = this.heading ? `${this.target} › ${this.heading}` : this.target;
    const open = el("button", "link", "Open");
    open.type = "button";
    open.title = `Open ${this.target} (Ctrl+click: in a split)`;
    open.addEventListener("click", (e) => { e.preventDefault(); this.ctx.openPage(this.target, e.ctrlKey || e.metaKey); });
    head.append(el("span", "cm-rich-embed-title", name), open);
    const body = el("div", "cm-rich-embed-body", "Loading…");
    box.append(head, body);
    let gone = false;
    embedCleanup.set(box, () => { gone = true; });
    this.ctx.readEmbed(this.target).then((page) => {
      if (gone) return;
      if (!page) { body.textContent = `No page is named ${this.target}.`; return; }
      const text = section(page.text, this.heading);
      if (text === null) { body.textContent = `${page.title} has no heading ${this.heading}.`; return; }
      body.textContent = "";
      const remove = this.ctx.renderEmbed(body, { ...page, text }, this.target);
      embedCleanup.set(box, () => { gone = true; remove(); });
    }, () => { if (!gone) body.textContent = `${this.target} could not be read.`; });
    return box;
  }
  destroy(dom: HTMLElement) { embedCleanup.get(dom)?.(); }
  // The embed is read-only and its links work: the editor leaves every event inside it alone.
  ignoreEvent() { return true; }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "✎", abstract: "≡", info: "i", todo: "☐", tip: "✦", success: "✓", question: "?", warning: "!",
  failure: "✕", danger: "‼", bug: "✱", example: "☰", quote: "❝",
};

/** A callout's first line (`> [!type]- Title`) shown as its title, with a fold button when it folds. */
export class CalloutTitleWidget extends WidgetType {
  constructor(readonly callout: Callout, readonly open: boolean) { super(); }
  eq(o: CalloutTitleWidget) {
    return o.callout.type === this.callout.type && o.callout.title === this.callout.title && o.callout.fold === this.callout.fold && o.open === this.open;
  }
  toDOM(view: EditorView) {
    const box = el("span", "cm-callout-title");
    box.append(el("span", "cm-callout-icon", CALLOUT_ICONS[this.callout.type] ?? CALLOUT_ICONS.note), el("span", "cm-callout-text", this.callout.title));
    if (this.callout.fold) {
      const fold = el("button", "cm-callout-fold", this.open ? "▾" : "▸");
      fold.type = "button";
      fold.setAttribute("aria-label", this.open ? "Fold" : "Unfold");
      fold.setAttribute("aria-expanded", String(this.open));
      // The callout's start is read when clicked: a widget kept across an edit above it has an old `at` (Codex review of
      // 398b956, P2).
      fold.addEventListener("mousedown", (e) => {
        e.preventDefault();
        let at: number;
        try { at = view.state.doc.lineAt(view.posAtDOM(box)).from; } catch { return; }
        view.dispatch({ effects: toggleCallout.of(at) });
      });
      box.append(fold);
    }
    return box;
  }
  ignoreEvent(e: Event) { return !!(e.target as Element).closest?.(".cm-callout-fold"); }
}

/** A footnote reference `[^id]` as a superscript; its definition is the tooltip. */
export class FootnoteWidget extends WidgetType {
  constructor(readonly id: string, readonly text: string | undefined) { super(); }
  eq(o: FootnoteWidget) { return o.id === this.id && o.text === this.text; }
  toDOM() {
    const sup = el("sup", "cm-footnote", this.id);
    sup.title = this.text ?? `No footnote [^${this.id}] is defined on this page.`;
    if (this.text === undefined) sup.classList.add("cm-footnote-missing");
    return sup;
  }
  ignoreEvent() { return false; }
}

// The table grid. Each cell is an input showing the cell's Markdown (`\|` shown as `|`); every edit writes the whole
// table back (`writeTable`), so the text is always the file. The grid's current source lives with its DOM, so a widget
// redrawn for the edit it just made keeps its inputs and the focus (`updateDOM`).
const gridSource = new WeakMap<HTMLElement, string>();
const shown = (cell: string) => cell.replace(/\\\|/g, "|");

type Op = (m: T.TableModel, at: number) => T.TableModel;
const COLUMN_OPS: [string, string, Op, (at: number) => number][] = [
  ["left", "Insert column left", (m, at) => T.insertColumn(m, at), (at) => at],
  ["right", "Insert column right", (m, at) => T.insertColumn(m, at + 1), (at) => at + 1],
  ["move-left", "Move column left", (m, at) => T.moveColumn(m, at, -1), (at) => Math.max(0, at - 1)],
  ["move-right", "Move column right", (m, at) => T.moveColumn(m, at, 1), (at) => at + 1],
  ["align-left", "Align left", (m, at) => T.alignColumn(m, at, "left"), (at) => at],
  ["align-center", "Align center", (m, at) => T.alignColumn(m, at, "center"), (at) => at],
  ["align-right", "Align right", (m, at) => T.alignColumn(m, at, "right"), (at) => at],
  ["align-none", "Clear alignment", (m, at) => T.alignColumn(m, at, null), (at) => at],
  ["delete", "Delete column", (m, at) => T.deleteColumn(m, at), (at) => Math.max(0, at - 1)],
];
const ROW_OPS: [string, string, Op, (at: number) => number][] = [
  ["above", "Insert row above", (m, at) => T.insertRow(m, at), (at) => at],
  ["below", "Insert row below", (m, at) => T.insertRow(m, at + 1), (at) => at + 1],
  ["up", "Move row up", (m, at) => T.moveRow(m, at, -1), (at) => Math.max(0, at - 1)],
  ["down", "Move row down", (m, at) => T.moveRow(m, at, 1), (at) => at + 1],
  ["delete", "Delete row", (m, at) => T.deleteRow(m, at), (at) => Math.max(-1, at - 1)],
];

/** Focus a cell of the grid whose source starts at `from`, once the editor has drawn it. */
function focusCell(view: EditorView, from: number, row: number, col: number) {
  for (const grid of view.dom.querySelectorAll<HTMLElement>(".cm-rich-table")) {
    let at: number;
    try { at = view.posAtDOM(grid); } catch { continue; }
    if (at !== from) continue;
    const input = grid.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-col="${col}"]`)
      ?? grid.querySelector<HTMLInputElement>(`input[data-row="${row}"]`) ?? grid.querySelector<HTMLInputElement>("input");
    input?.focus();
    return;
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly readOnly: boolean) { super(); }
  eq(o: TableWidget) { return o.source === this.source && o.readOnly === this.readOnly; }
  get estimatedHeight() { return 32 * (this.source.split("\n").length - 1); }

  toDOM(view: EditorView) {
    const box = el("div", "cm-rich-table cm-rich-block");
    gridSource.set(box, this.source);
    this.fill(box, view);
    return box;
  }

  updateDOM(dom: HTMLElement) {
    const model = T.parseTable(this.source);
    const inputs = dom.querySelectorAll<HTMLInputElement>("input[data-row]");
    // Both dimensions must match: 2 columns by 2 rows and 1 column by 4 rows have as many cells (Codex review of 398b956).
    const same = model && dom.dataset.rows === String(model.rows.length) && dom.dataset.cols === String(model.header.length);
    if (!model || !same || dom.dataset.readOnly !== String(this.readOnly)) return false;
    gridSource.set(dom, this.source);
    for (const input of inputs) {
      const row = Number(input.dataset.row), col = Number(input.dataset.col);
      const want = shown(row < 0 ? model.header[col] : model.rows[row][col]);
      if (input.value !== want) input.value = want;
    }
    dom.querySelectorAll<HTMLTableCellElement>("[data-col]").forEach((c) => { c.style.textAlign = model.align[Number(c.dataset.col)] ?? ""; });
    return true;
  }

  /** Replace the table with `next`, then focus a cell. Returns false when the page no longer holds this table. */
  private write(view: EditorView, box: HTMLElement, next: T.TableModel, focus?: { row: number; col: number }): boolean {
    const source = gridSource.get(box)!;
    const from = sourceAt(view, box, source);
    if (from === null || view.state.readOnly) return false;
    const text = T.writeTable(next);
    gridSource.set(box, text);
    view.dispatch({ changes: { from, to: from + source.length, insert: text }, userEvent: "input.table" });
    if (focus) focusCell(view, from, focus.row, focus.col);
    return true;
  }

  private model(box: HTMLElement): T.TableModel | null {
    return T.parseTable(gridSource.get(box) ?? "");
  }

  private fill(box: HTMLElement, view: EditorView) {
    const model = T.parseTable(this.source);
    box.dataset.readOnly = String(this.readOnly);
    if (!model) { box.textContent = this.source; return; }
    box.dataset.rows = String(model.rows.length);
    box.dataset.cols = String(model.header.length);
    const table = el("table");
    const cols = model.header.length;
    const cell = (row: number, col: number, text: string) => {
      const input = el("input");
      input.value = shown(text);
      input.dataset.row = String(row);
      input.dataset.col = String(col);
      input.readOnly = this.readOnly;
      input.setAttribute("aria-label", row < 0 ? `Header, column ${col + 1}` : `Row ${row + 1}, column ${col + 1}`);
      input.addEventListener("input", () => {
        const m = this.model(box);
        if (m) this.write(view, box, T.setCell(m, row, col, input.value));
      });
      input.addEventListener("keydown", (e) => this.key(e, view, box, row, col));
      return input;
    };
    const menu = (label: string, ops: typeof COLUMN_OPS, at: number, focusOf: (n: number) => { row: number; col: number }) => {
      const select = el("select", "cm-rich-table-menu");
      select.setAttribute("aria-label", label);
      select.tabIndex = -1;
      select.disabled = this.readOnly;
      select.append(el("option", undefined, "⋯"));
      for (const [value, text] of ops) { const o = el("option", undefined, text); o.value = value; select.append(o); }
      select.addEventListener("change", () => {
        const op = ops.find(([value]) => value === select.value);
        select.selectedIndex = 0;
        const m = this.model(box);
        if (op && m) this.write(view, box, op[2](m, at), focusOf(op[3](at)));
      });
      return select;
    };
    const head = el("tr");
    head.append(el("th", "cm-rich-table-gutter"));
    model.header.forEach((text, col) => {
      const th = el("th");
      th.dataset.col = String(col);
      th.style.textAlign = model.align[col] ?? "";
      th.append(cell(-1, col, text), menu(`Column ${col + 1} actions`, COLUMN_OPS, col, (c) => ({ row: -1, col: Math.min(c, cols) })));
      head.append(th);
    });
    const body = el("tbody");
    model.rows.forEach((row, r) => {
      const tr = el("tr");
      const gutter = el("td", "cm-rich-table-gutter");
      gutter.append(menu(`Row ${r + 1} actions`, ROW_OPS, r, (n) => ({ row: n, col: 0 })));
      tr.append(gutter);
      row.forEach((text, col) => {
        const td = el("td");
        td.dataset.col = String(col);
        td.style.textAlign = model.align[col] ?? "";
        td.append(cell(r, col, text));
        tr.append(td);
      });
      body.append(tr);
    });
    const thead = el("thead");
    thead.append(head);
    table.append(thead, body);
    box.replaceChildren(table);
  }

  /** Tab and Shift+Tab move between cells (Tab in the last cell adds a row), Enter adds a row below, the arrows move
   *  up and down and leave the grid at its edges, and Escape leaves it with the cursor on its source. */
  private key(e: KeyboardEvent, view: EditorView, box: HTMLElement, row: number, col: number) {
    const m = this.model(box);
    if (!m) return;
    const cols = m.header.length, last = m.rows.length - 1;
    const leave = (where: "start" | "before" | "after") => {
      const source = gridSource.get(box)!;
      const from = sourceAt(view, box, source);
      if (from === null) return;
      const to = from + source.length;
      const anchor = where === "start" ? from : where === "before" ? Math.max(0, from - 1) : Math.min(view.state.doc.length, to + 1);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    };
    const go = (r: number, c: number) => { e.preventDefault(); box.querySelector<HTMLInputElement>(`input[data-row="${r}"][data-col="${c}"]`)?.focus(); };
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const index = (row + 1) * cols + col + (e.shiftKey ? -1 : 1);
      if (index < 0) return;
      if (index >= (last + 2) * cols) { this.write(view, box, T.insertRow(m, last + 1), { row: last + 1, col: 0 }); return; }
      go(Math.floor(index / cols) - 1, index % cols);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.write(view, box, T.insertRow(m, row + 1), { row: row + 1, col });
    } else if (e.key === "ArrowUp") {
      if (row < 0) { e.preventDefault(); leave("before"); } else go(row - 1, col);
    } else if (e.key === "ArrowDown") {
      if (row >= last) { e.preventDefault(); leave("after"); } else go(row + 1, col);
    } else if (e.key === "Escape") {
      e.preventDefault();
      leave("start");
    }
  }

  // Inside the grid the editor only takes its own shortcuts: save, undo and redo.
  ignoreEvent(e: Event) {
    if (e instanceof KeyboardEvent && (e.ctrlKey || e.metaKey) && /^[szy]$/i.test(e.key)) return false;
    return true;
  }
}
