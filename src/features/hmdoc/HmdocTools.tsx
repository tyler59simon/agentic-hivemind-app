// The rich page's own controls (NS-3C): colours, columns, toggles and table options in the toolbar, and the dialogs for
// a table's sort and filter and for the page's width and cover. NS-3B's toolbar carries these as its `extra`.
import type { Editor } from "@tiptap/core";
import { Baseline, Columns3, Highlighter, ListCollapse, Settings2, TableCellsMerge, TableCellsSplit, TableProperties } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { pictureExt } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { addColumn, inColumns, insertColumns, MAX_COLUMNS, MIN_COLUMNS, removeColumn } from "./blocks/columns";
import { insertToggle } from "./blocks/toggle";
import { FILTER_OPS, type FilterOp, type Meta, type TableView } from "./envelope";
import { columnLabel } from "./formulas";
import { PAGE_WIDTHS, PALETTE, type Colour, type PageWidth } from "./palette";

const swatch = (c: Colour) => <span className={`hm-swatch hm-bg-${c}`} aria-hidden />;

function Palette({ label, icon, none, pick }: { label: string; icon: ReactNode; none: string; pick: (c: Colour | null) => void }) {
  return (
    <Menu align="left" label={label} button={icon} className="icon-menu">
      {(done) => (
        <>
          {PALETTE.map((c) => <li key={c}><button role="menuitem" onClick={() => { done(); pick(c); }}>{swatch(c)}{c}</button></li>)}
          <li><button role="menuitem" onClick={() => { done(); pick(null); }}>{none}</button></li>
        </>
      )}
    </Menu>
  );
}

/** The controls after NS-3B's table ones. Nothing shows while the page is read-only. */
export function HmdocTools({ editor, readOnly, onSettings, onTableView }: { editor: Editor; readOnly: boolean; onSettings: () => void; onTableView: () => void }) {
  if (readOnly) return null;
  const run = (f: (c: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => f(editor.chain().focus()).run();
  const inTable = editor.isActive("table");
  return (
    <>
      <span className="rich-toolbar-sep" aria-hidden />
      <Palette label="Text colour" icon={<Baseline size="1em" />} none="No colour" pick={(c) => run((ch) => (c ? ch.setMark("textColor", { color: c }) : ch.unsetMark("textColor")))} />
      <Palette label="Highlight colour" icon={<Highlighter size="1em" />} none="No highlight" pick={(c) => run((ch) => (c ? ch.setMark("highlight", { color: c }) : ch.unsetMark("highlight")))} />
      <Menu align="left" label="Columns" button={<Columns3 size="1em" />} className="icon-menu">
        {(close) => (
          <>
            {Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, i) => MIN_COLUMNS + i).map((n) => (
              <li key={n}><button role="menuitem" onClick={() => { close(); insertColumns(editor, n); }}>{n} columns</button></li>
            ))}
            {inColumns(editor) && <li><button role="menuitem" onClick={() => { close(); addColumn(editor); }}>Add a column</button></li>}
            {inColumns(editor) && <li><button role="menuitem" onClick={() => { close(); removeColumn(editor); }}>Remove this column</button></li>}
          </>
        )}
      </Menu>
      <button type="button" className="icon-button" aria-label="Toggle" title="Toggle (a block that opens and closes)" onMouseDown={(e) => { e.preventDefault(); insertToggle(editor); }}>
        <ListCollapse size="1em" />
      </button>
      {inTable && (
        <Menu align="left" label="Table options" button={<TableProperties size="1em" />} className="icon-menu">
          {(close) => {
            const item = (text: string, act: () => void, icon?: ReactNode) => <li key={text}><button role="menuitem" onClick={() => { close(); act(); }}>{icon}{text}</button></li>;
            return (
              <>
                {item("Merge cells", () => run((c) => c.mergeCells()), <TableCellsMerge size="1em" />)}
                {item("Split cell", () => run((c) => c.splitCell()), <TableCellsSplit size="1em" />)}
                {item("Header row on or off", () => run((c) => c.toggleHeaderRow()))}
                {item("Header column on or off", () => run((c) => c.toggleHeaderColumn()))}
                {PALETTE.map((c) => item(`Cell colour: ${c}`, () => run((ch) => ch.setCellAttribute("background", c)), swatch(c)))}
                {item("Cell colour: none", () => run((c) => c.setCellAttribute("background", null)))}
                {item("Sort and filter…", onTableView)}
              </>
            );
          }}
        </Menu>
      )}
      <span className="fill" />
      <button type="button" className="icon-button" aria-label="Page settings" title="Page width and cover image" onMouseDown={(e) => { e.preventDefault(); onSettings(); }}>
        <Settings2 size="1em" />
      </button>
    </>
  );
}

const OPS: Record<FilterOp, string> = {
  contains: "contains", equals: "is", greater: "is greater than", less: "is less than", empty: "is empty", filled: "is not empty",
};

/** A table's sort and filter. They are saved with the page and never reorder the stored rows. */
export function TableViewDialog({ labels, rowSpans, view, onApply, onClose }: {
  /** Each column's name: its letter, and its header text when there is one. */
  labels: string[]; rowSpans: boolean; view: TableView | undefined; onApply: (view: TableView | undefined) => void; onClose: () => void;
}) {
  const [sortColumn, setSortColumn] = useState(view?.sort?.column ?? 0);
  const [dir, setDir] = useState<"none" | "asc" | "desc">(view?.sort?.dir ?? "none");
  const [filterColumn, setFilterColumn] = useState(view?.filter?.column ?? 0);
  const [op, setOp] = useState<FilterOp | "none">(view?.filter?.op ?? "none");
  const [value, setValue] = useState(view?.filter?.value ?? "");
  const columns = (current: number, set: (n: number) => void, label: string) => (
    <select aria-label={label} value={current} onChange={(e) => set(Number(e.target.value))}>
      {labels.map((l, i) => <option key={i} value={i}>{l}</option>)}
    </select>
  );
  const apply = () => {
    const next: TableView = {};
    if (dir !== "none" && !rowSpans) next.sort = { column: sortColumn, dir };
    if (op !== "none" && !rowSpans) next.filter = { column: filterColumn, op, value: op === "empty" || op === "filled" ? "" : value };
    onApply(next.sort || next.filter ? next : undefined);
    onClose();
  };
  return (
    <Modal title="Sort and filter" onClose={onClose}>
      <p className="muted">Sorting and filtering change only how the table is shown. The rows keep their saved order, and the settings are saved with the page.</p>
      <div className="hm-view-row">
        <span>Sort by</span>
        {columns(sortColumn, setSortColumn, "Sort column")}
        <select aria-label="Sort order" value={dir} disabled={rowSpans} onChange={(e) => setDir(e.target.value as typeof dir)}>
          <option value="none">Not sorted</option><option value="asc">Ascending</option><option value="desc">Descending</option>
        </select>
      </div>
      {rowSpans && <p className="muted">Sorting and filtering are not available while a cell spans rows.</p>}
      <div className="hm-view-row">
        <span>Show rows where</span>
        {columns(filterColumn, setFilterColumn, "Filter column")}
        <select aria-label="Filter" value={op} disabled={rowSpans} onChange={(e) => setOp(e.target.value as typeof op)}>
          <option value="none">Show all rows</option>
          {FILTER_OPS.map((o) => <option key={o} value={o}>{OPS[o]}</option>)}
        </select>
        {op !== "none" && op !== "empty" && op !== "filled" && <input aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} />}
      </div>
      <div className="actions">
        <button className="primary" onClick={apply}>Apply</button>
        <button onClick={() => { onApply(undefined); onClose(); }}>Clear sort and filter</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** The page's width and cover image. */
export function PageDialog({ meta, pictures, ctx, onPatch, onClose }: {
  meta: Meta; pictures: string[]; ctx: RichContext; onPatch: (patch: Partial<Meta>) => void; onClose: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const width = meta.width ?? "normal";
  // Each change is a patch the page applies to its settings as they are then, not to the ones this dialog drew (R1-17).
  const set = onPatch;
  const add = async (files: FileList | null) => {
    const file = [...(files ?? [])].find((f) => pictureExt(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name));
    if (!file || !ctx.attachPath) return;
    try { set({ cover: await ctx.attachPath(new Uint8Array(await file.arrayBuffer()), file.name) }); } catch (e) { ctx.fail(`${file.name} was not attached: ${e instanceof Error ? e.message : String(e)}`); }
  };
  return (
    <Modal title="Page settings" onClose={onClose}>
      <label className="hm-view-row"><span>Page width</span>
        <select aria-label="Page width" value={width} onChange={(e) => set({ width: e.target.value as PageWidth })}>
          {PAGE_WIDTHS.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </label>
      <label className="hm-view-row"><span>Cover image</span>
        <select aria-label="Cover image" value={meta.cover ?? ""} onChange={(e) => set({ cover: e.target.value || undefined })}>
          <option value="">No cover</option>
          {meta.cover && !pictures.includes(meta.cover) && <option value={meta.cover}>{meta.cover}</option>}
          {pictures.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <div className="actions">
        {ctx.attachPath && <button onClick={() => picker.current?.click()}>Add a picture…</button>}
        <input ref={picker} type="file" accept="image/*" hidden onChange={(e) => { const files = e.target.files; void add(files).finally(() => { e.target.value = ""; }); }} />
        <button className="primary" onClick={onClose}>Done</button>
      </div>
      <p className="muted">You can also paste or drop a picture on the cover strip above the page.</p>
    </Modal>
  );
}

/** The columns of a table for the sort and filter lists: the letter formulas use, and the header text when there is one. */
export function columnNames(width: number, headers: string[]): string[] {
  return Array.from({ length: width }, (_, i) => (headers[i]?.trim() ? `${columnLabel(i)} (${headers[i].trim()})` : columnLabel(i)));
}
