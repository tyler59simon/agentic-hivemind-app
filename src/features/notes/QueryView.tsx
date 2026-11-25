// A query's answer as a table or a board (NS-7B). A table cell edits the property in place; dragging a card to another column
// of a board sets the board's property to that column. Each write goes to that one page against the hash the
// answer showed it at (`writes.ts`), so a page that changed meanwhile is refused and the answer is read again.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { classify } from "../../lib/errors";
import { notebooksQuery, pageTitle } from "../../lib/notebooks";
import { INDEX_KEY } from "../../lib/noteindex";
import { toast } from "../../ui/toast";
import { openPage } from "./actions";
import { fromText, type PropValue } from "./frontmatter";
import { refreshLists } from "./pageWrite";
import { columnsOf, parseSpecText, runQuery, valueOf, type QueryRow, type QuerySpec } from "./queries";
import { clearPageProperty, setPageProperty } from "./writes";

const PSEUDO = ["title", "path", "notebook"];
const keyOfRow = (r: QueryRow) => `${r.notebook}:${r.path}`;
const NONE = "";

/** Writes one property of one page and says what a person needs to hear: a refusal, or that an open page is not saved. */
function useWriteProp() {
  const client = useQueryClient();
  return async (row: QueryRow, key: string, value: PropValue | null) => {
    const page = { notebook: row.notebook, path: row.path, hash: row.hash };
    try {
      const out = value === null ? await clearPageProperty(page, key) : await setPageProperty(page, key, value);
      if (out === "unsaved") toast(`Changed in the open page ${pageTitle(row.path)}. It has unsaved edits, so save it to keep the change.`, "info");
      return true;
    } catch (e) {
      toast(classify(e).message, "error");
      return false;
    } finally {
      refreshLists(client);
    }
  };
}

/** The text a property shows: its values joined, or nothing. */
const shown = (row: QueryRow, key: string) => {
  const v = key === "title" ? row.title : key === "path" ? row.path : key === "notebook" ? row.notebook : row.props[key];
  return Array.isArray(v) ? v.join(", ") : v ?? "";
};

/** What typing `raw` into a property's cell means: a list when the property has several values, else its typed value; nothing
 *  at all clears the property. */
function valueOfCell(row: QueryRow, key: string, raw: string): PropValue | null {
  const text = raw.trim();
  if (!text) return null;
  return Array.isArray(row.props[key]) ? text.split(",").map((s) => s.trim()).filter(Boolean) : fromText(text);
}

function Cell({ row, column, write }: { row: QueryRow; column: string; write: (row: QueryRow, key: string, value: PropValue | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const text = shown(row, column);
  if (PSEUDO.includes(column)) return <td className="muted">{text}</td>;
  if (!editing) return <td><button type="button" className="cell" title="Edit" onClick={() => setEditing(true)}>{text || <span className="muted">-</span>}</button></td>;
  const done = (raw: string, save: boolean) => {
    setEditing(false);
    if (save && raw.trim() !== text.trim()) void write(row, column, valueOfCell(row, column, raw));
  };
  return (
    <td>
      <input autoFocus aria-label={`${column} of ${pageTitle(row.path)}`} defaultValue={text}
        onBlur={(e) => done(e.target.value, true)}
        onKeyDown={(e) => { if (e.key === "Enter") done((e.target as HTMLInputElement).value, true); else if (e.key === "Escape") done("", false); }} />
    </td>
  );
}

function Table({ spec, rows, names, write }: { spec: QuerySpec; rows: QueryRow[]; names: (r: QueryRow) => string; write: (row: QueryRow, key: string, value: PropValue | null) => Promise<boolean> }) {
  const columns = columnsOf(spec);
  return (
    <div className="query-scroll">
      <table className="query-table">
        <thead><tr><th>Page</th>{columns.map((c) => <th key={c}>{c}</th>)}<th>Notebook</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={keyOfRow(r)}>
              <td><button type="button" className="link" onClick={() => openPage({ notebook: r.notebook, path: r.path })}>{r.title || pageTitle(r.path)}</button></td>
              {columns.map((c) => <Cell key={c} row={r} column={c} write={write} />)}
              <td className="muted small">{names(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Board({ spec, rows, write }: { spec: QuerySpec; rows: QueryRow[]; write: (row: QueryRow, key: string, value: PropValue | null) => Promise<boolean> }) {
  const group = spec.groupBy!;
  // A card dropped in a column shows there at once; the answer read again settles it.
  const [moved, setMoved] = useState<Record<string, string>>({});
  useEffect(() => setMoved({}), [rows]);
  const columnOf = (r: QueryRow) => moved[keyOfRow(r)] ?? valueOf(r, group) ?? NONE;
  const names = useMemo(() => {
    const found: string[] = [];
    for (const r of rows) { const c = columnOf(r); if (c !== NONE && !found.includes(c)) found.push(c); }
    return [...found, NONE];
  }, [rows, moved]); // eslint-disable-line react-hooks/exhaustive-deps
  const [over, setOver] = useState<string | null>(null);
  const drop = async (column: string, id: string) => {
    setOver(null);
    const row = rows.find((r) => keyOfRow(r) === id);
    if (!row || columnOf(row) === column) return;
    const held = row.props[group];
    if (Array.isArray(held) && held.length > 1) { toast(`${pageTitle(row.path)} has several values for ${group}, so Hivemind does not move it.`, "warn"); return; }
    setMoved((m) => ({ ...m, [id]: column }));
    if (!(await write(row, group, column === NONE ? null : fromText(column)))) setMoved((m) => { const { [id]: _gone, ...rest } = m; return rest; });
  };
  const fields = columnsOf(spec).filter((c) => c !== group && c !== "title");
  return (
    <div className="query-board">
      {names.map((column) => (
        <div key={column || "none"} className={`board-column${over === column ? " over" : ""}`} role="group" aria-label={column || `No ${group}`}
          onDragOver={(e) => { e.preventDefault(); setOver(column); }} onDragLeave={() => setOver((o) => (o === column ? null : o))}
          onDrop={(e) => { e.preventDefault(); void drop(column, e.dataTransfer.getData("text/plain")); }}>
          <h3>{column || `No ${group}`} <span className="muted small">{rows.filter((r) => columnOf(r) === column).length}</span></h3>
          {rows.filter((r) => columnOf(r) === column).map((r) => (
            <div key={keyOfRow(r)} className="board-card" draggable role="group" aria-label={`Card ${r.title || pageTitle(r.path)}`} onDragStart={(e) => { e.dataTransfer.setData("text/plain", keyOfRow(r)); e.dataTransfer.effectAllowed = "move"; }}>
              <button type="button" className="link" onClick={() => openPage({ notebook: r.notebook, path: r.path })}>{r.title || pageTitle(r.path)}</button>
              {fields.map((f) => shown(r, f) && <div key={f} className="small"><span className="muted">{f}</span> {shown(r, f)}</div>)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A query's rows as its view says. `refetch`-able through the shared query key. */
export function QueryResults({ spec, rows }: { spec: QuerySpec; rows: QueryRow[] }) {
  const write = useWriteProp();
  const folders = useQuery(notebooksQuery());
  const names = useMemo(() => {
    const map = new Map((folders.data ?? []).map((n) => [n.id, n.title]));
    return (r: QueryRow) => map.get(r.notebook) ?? r.notebook;
  }, [folders.data]);
  if (!rows.length) return <p className="muted pad">No page matches this query.</p>;
  return spec.view === "board" && spec.groupBy ? <Board spec={spec} rows={rows} write={write} /> : <Table spec={spec} rows={rows} names={names} write={write} />;
}

/** Run a query and show its answer. */
export function QueryRun({ spec }: { spec: QuerySpec }) {
  const result = useQuery({ queryKey: [INDEX_KEY, "query", JSON.stringify(spec)], queryFn: () => runQuery(spec) });
  return (
    <div className="query-run">
      {result.isLoading && <p className="muted pad">Running the query…</p>}
      {result.error && <p className="error pad">{classify(result.error).message}</p>}
      {result.data?.problems.map((p) => <p key={p} className="error small pad">{p}</p>)}
      {result.data && <QueryResults spec={spec} rows={result.data.rows} />}
    </div>
  );
}

/** A ```query block of a page: its JSON, drawn as the table or board it asks for. */
export function QueryBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseSpecText(source), [source]);
  if (!parsed.ok) return <div className="query-block"><p className="error small">This query block is not valid: {parsed.error}.</p><pre>{source}</pre></div>;
  return <div className="query-block"><QueryRun spec={parsed.spec} /></div>;
}
