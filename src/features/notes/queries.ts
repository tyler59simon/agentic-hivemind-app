// Saved queries (NS-7B): the query definition, the form that makes it, and running it over both kinds of notebook. A query
// is a small JSON document (version 1) kept in a ```query block of a page or as a saved view in a folder notebook's
// `.hivemind/queries/<name>.json`. Folder notebooks answer it from the index (`index_query`); Living Memory notebooks answer
// it through `doc query`, to which it is translated. Both follow the same rules (`notes_index/structured.rs`), so the two
// answers can be merged and sorted again here.
import { invoke } from "@tauri-apps/api/core";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { docQuery, type DocQueryPage } from "../../lib/lm";

export type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "exists" | "missing";
export const OPS: { id: Op; label: string; lm: string; valued: boolean }[] = [
  { id: "eq", label: "is", lm: "=", valued: true },
  { id: "ne", label: "is not", lm: "!=", valued: true },
  { id: "lt", label: "is less than", lm: "<", valued: true },
  { id: "le", label: "is at most", lm: "<=", valued: true },
  { id: "gt", label: "is more than", lm: ">", valued: true },
  { id: "ge", label: "is at least", lm: ">=", valued: true },
  { id: "contains", label: "contains", lm: "contains", valued: true },
  { id: "exists", label: "has a value", lm: "exists", valued: false },
  { id: "missing", label: "has no value", lm: "missing", valued: false },
];

export interface Cond { prop: string; op: Op; value?: string }
export interface SortKey { prop: string; dir: "asc" | "desc" }
export type ViewKind = "table" | "board";

export interface QuerySpec {
  version: 1;
  /** `notebooks` holds container ids (a folder notebook's id, or `lm:<domain>:<notebook>`); none means every notebook. */
  from: { notebooks: string[]; folder: string | null; tag: string | null };
  where: Cond[];
  sort: SortKey[];
  view: ViewKind;
  /** The properties a table shows after the title; a board shows them on its cards. */
  columns: string[];
  /** The property a board groups its cards by. */
  groupBy: string | null;
  limit: number;
}

export const MAX_LIMIT = 1000;
export const MAX_WHERE = 10;
export const MAX_SORT = 5;

export const newSpec = (): QuerySpec => ({ version: 1, from: { notebooks: [], folder: null, tag: null }, where: [], sort: [], view: "table", columns: [], groupBy: null, limit: 500 });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** The query a JSON value says, checked: a plain error message when it is not one. Fields it does not know are dropped. */
export function parseSpec(raw: unknown): { ok: true; spec: QuerySpec } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "A query is a JSON object" };
  if (raw.version !== 1) return { ok: false, error: "A query needs \"version\": 1" };
  const spec = newSpec();
  const from = raw.from === undefined ? {} : raw.from;
  if (!isObject(from)) return { ok: false, error: "\"from\" is an object with notebooks, folder and tag" };
  if (from.notebooks !== undefined && (!Array.isArray(from.notebooks) || from.notebooks.some((n) => typeof n !== "string"))) return { ok: false, error: "\"from.notebooks\" is a list of notebook ids" };
  spec.from = {
    notebooks: (from.notebooks as string[] | undefined) ?? [],
    folder: typeof from.folder === "string" && from.folder.trim() ? from.folder.trim().replace(/^\/+|\/+$/g, "") : null,
    tag: typeof from.tag === "string" && from.tag.trim() ? from.tag.trim().replace(/^#/, "").toLowerCase() : null,
  };
  const where = raw.where ?? [];
  if (!Array.isArray(where) || where.length > MAX_WHERE) return { ok: false, error: `"where" is a list of at most ${MAX_WHERE} conditions` };
  for (const c of where) {
    const op = OPS.find((o) => isObject(c) && o.id === c.op);
    if (!isObject(c) || typeof c.prop !== "string" || !c.prop.trim() || !op) return { ok: false, error: `A condition is { "prop", "op", "value" } with an op of ${OPS.map((o) => o.id).join(", ")}` };
    const value = text(c.value);
    if (op.valued && value === undefined) return { ok: false, error: `The condition on ${c.prop} needs a value` };
    spec.where.push({ prop: c.prop.trim(), op: op.id, ...(op.valued ? { value } : {}) });
  }
  const sort = raw.sort ?? [];
  if (!Array.isArray(sort) || sort.length > MAX_SORT) return { ok: false, error: `"sort" is a list of at most ${MAX_SORT} keys` };
  for (const s of sort) {
    if (!isObject(s) || typeof s.prop !== "string" || !s.prop.trim() || (s.dir !== undefined && s.dir !== "asc" && s.dir !== "desc")) return { ok: false, error: "A sort key is { \"prop\", \"dir\": \"asc\" or \"desc\" }" };
    spec.sort.push({ prop: s.prop.trim(), dir: s.dir === "desc" ? "desc" : "asc" });
  }
  if (raw.view !== undefined && raw.view !== "table" && raw.view !== "board") return { ok: false, error: "\"view\" is table or board" };
  spec.view = raw.view === "board" ? "board" : "table";
  if (raw.columns !== undefined && (!Array.isArray(raw.columns) || raw.columns.some((c) => typeof c !== "string"))) return { ok: false, error: "\"columns\" is a list of property names" };
  spec.columns = ((raw.columns as string[] | undefined) ?? []).map((c) => c.trim()).filter(Boolean);
  spec.groupBy = typeof raw.groupBy === "string" && raw.groupBy.trim() ? raw.groupBy.trim() : null;
  if (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_LIMIT)) return { ok: false, error: `"limit" is a whole number from 1 to ${MAX_LIMIT}` };
  spec.limit = (raw.limit as number | undefined) ?? 500;
  if (spec.view === "board" && !spec.groupBy) return { ok: false, error: "A board needs \"groupBy\": the property its columns are made from" };
  return { ok: true, spec };
}

/** The text of a ```query block: JSON. */
export function parseSpecText(source: string) {
  try {
    return parseSpec(JSON.parse(source));
  } catch {
    return { ok: false as const, error: "The query is not valid JSON" };
  }
}

export const specJson = (spec: QuerySpec) => JSON.stringify(spec, null, 2);

/** What the query form holds: every field as the user typed it. */
export interface QueryForm {
  notebooks: string[];
  folder: string;
  tag: string;
  where: { prop: string; op: Op; value: string }[];
  sort: SortKey[];
  view: ViewKind;
  /** Comma separated property names. */
  columns: string;
  groupBy: string;
  limit: string;
}

export const formOf = (spec: QuerySpec): QueryForm => ({
  notebooks: spec.from.notebooks, folder: spec.from.folder ?? "", tag: spec.from.tag ?? "",
  where: spec.where.map((c) => ({ prop: c.prop, op: c.op, value: c.value ?? "" })), sort: spec.sort, view: spec.view,
  columns: spec.columns.join(", "), groupBy: spec.groupBy ?? "", limit: String(spec.limit),
});

/** The query the form makes. Empty rows are left out, and the same checks as a query in a page apply. */
export function specOf(form: QueryForm) {
  return parseSpec({
    version: 1,
    from: { notebooks: form.notebooks, folder: form.folder, tag: form.tag },
    where: form.where.filter((c) => c.prop.trim()).map((c) => ({ prop: c.prop, op: c.op, ...(OPS.find((o) => o.id === c.op)?.valued ? { value: c.value } : {}) })),
    sort: form.sort.filter((s) => s.prop.trim()),
    view: form.view,
    columns: form.columns.split(",").map((c) => c.trim()).filter(Boolean),
    groupBy: form.groupBy,
    limit: form.limit.trim() ? Number(form.limit) : 500,
  });
}

// ---- running a query -----------------------------------------------------------------------------------------------

/** A page a query found, from either kind of notebook. `notebook` is the container id; `hash` is the hash or revision the
 *  page had when it was indexed, which a write checks. Every value is text, or a list of text for a key with several. */
export interface QueryRow {
  notebook: string; path: string; title: string; hash: string; props: Record<string, string | string[]>; lm: boolean;
}

interface RustRow { notebook: string; path: string; title: string; sha256: string; mtimeMs: number; props: Record<string, string | string[]> }

const isLmId = (id: string) => id.startsWith("lm:");

/** The part of a query the index evaluates. */
export const forIndex = (spec: QuerySpec) => ({
  from: { notebooks: spec.from.notebooks.filter((n) => !isLmId(n)), folder: spec.from.folder, tag: spec.from.tag },
  where: spec.where, sort: spec.sort, limit: spec.limit,
});

/** The payload of `doc query` for the same query: `prop` and `dir` become `key` and `order`, the operators become Living
 *  Memory's, a folder becomes a range over `path` (every path from `folder/` up to `folder0`, since `0` comes right after
 *  `/`), and a tag becomes the `tags` property. One Living Memory notebook is named in `notebook`; with several, the rows
 *  are filtered after the answer. */
export function toLmPayload(spec: QuerySpec) {
  const where: { key: string; op: string; value?: string }[] = spec.where.map((c) => ({ key: c.prop, op: OPS.find((o) => o.id === c.op)!.lm, ...(c.value !== undefined ? { value: c.value } : {}) }));
  if (spec.from.folder) where.push({ key: "path", op: ">=", value: `${spec.from.folder}/` }, { key: "path", op: "<", value: `${spec.from.folder}0` });
  if (spec.from.tag) where.push({ key: "tags", op: "=", value: spec.from.tag });
  const lm = spec.from.notebooks.filter(isLmId);
  const one = lm.length === 1 ? lm[0].slice(lm[0].lastIndexOf(":") + 1) : undefined;
  return { where, sort: spec.sort.map((s) => ({ key: s.prop, order: s.dir })), limit: spec.limit, ...(one ? { notebook: one } : {}) };
}

const lmRow = (p: DocQueryPage): QueryRow => ({ notebook: lmContainer(p.domain, p.notebook), path: p.path, title: p.title ?? "", hash: p.revision, props: p.properties ?? {}, lm: true });
const folderRow = (r: RustRow): QueryRow => ({ notebook: r.notebook, path: r.path, title: r.title, hash: r.sha256, props: r.props, lm: false });

const NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const number = (v: string) => (NUMBER.test(v) ? Number(v) : null);

/** The order the index and Living Memory sort by: numbers by value, then text by lower case. */
export function compareValues(a: string, b: string): number {
  const [x, y] = [number(a), number(b)];
  if (x !== null && y !== null) return x - y;
  if (x !== null) return -1;
  if (y !== null) return 1;
  const [p, q] = [a.toLowerCase(), b.toLowerCase()];
  return p < q ? -1 : p > q ? 1 : 0;
}

/** The first value of a property of a row, or undefined when it has none. The pseudo keys are the page's own. */
export function valueOf(row: QueryRow, key: string): string | undefined {
  if (key === "title") return row.title;
  if (key === "path") return row.path;
  if (key === "notebook") return row.notebook;
  const v = row.props[key];
  return Array.isArray(v) ? v[0] : v;
}

/** `rows` sorted by the keys (the last key first, each pass stable, as Living Memory does), a row without the key last. */
export function sortRows(rows: QueryRow[], sort: SortKey[]): QueryRow[] {
  let out = rows;
  for (const s of [...sort].reverse()) {
    const present = out.filter((r) => valueOf(r, s.prop) !== undefined);
    const absent = out.filter((r) => valueOf(r, s.prop) === undefined);
    present.sort((a, b) => (s.dir === "desc" ? -1 : 1) * compareValues(valueOf(a, s.prop)!, valueOf(b, s.prop)!));
    out = [...present, ...absent];
  }
  return out;
}

export interface QueryResult { rows: QueryRow[]; /** One line for each source that could not answer. */ problems: string[] }

/** Run a query over the notebooks it names (every one when it names none). `lm` says Living Memory can answer `doc query`.
 *  A source that fails is said in `problems` while the other still answers. */
export async function runQuery(spec: QuerySpec, lm: boolean): Promise<QueryResult> {
  const named = spec.from.notebooks;
  const wantFolder = !named.length || named.some((n) => !isLmId(n));
  const wantLm = lm && (!named.length || named.some(isLmId));
  const problems: string[] = [];
  const [folder, living] = await Promise.all([
    wantFolder ? invoke<RustRow[]>("index_query", { query: forIndex(spec) }).then((r) => (r ?? []).map(folderRow), (e) => { problems.push(String(e)); return [] as QueryRow[]; }) : [],
    wantLm ? docQuery(toLmPayload(spec)).then((r) => r.map(lmRow), (e) => { problems.push(`Living Memory notebooks: ${e instanceof Error ? e.message : String(e)}`); return [] as QueryRow[]; }) : [],
  ]);
  const lmNamed = named.filter(isLmId);
  const kept = lmNamed.length > 1 ? living.filter((r) => lmNamed.includes(r.notebook)) : living;
  return { rows: sortRows([...folder, ...kept], spec.sort).slice(0, spec.limit), problems };
}

/** The columns a table shows: its own, or the title and the properties the query asks about. */
export function columnsOf(spec: QuerySpec): string[] {
  if (spec.columns.length) return spec.columns;
  const asked = [...spec.where.map((c) => c.prop), ...spec.sort.map((s) => s.prop), ...(spec.groupBy ? [spec.groupBy] : [])];
  return [...new Set(asked)].filter((k) => k !== "title");
}

// ---- saved views -----------------------------------------------------------------------------------------------------

/** A saved view of a folder notebook: one file, `.hivemind/queries/<name>.json`. `spec` is what the file holds, not yet checked. */
export interface SavedView { name: string; spec: unknown }
export const queryViews = (notebook: string) => invoke<SavedView[]>("query_views", { notebook }).then((r) => r ?? []);
export const saveQueryView = (notebook: string, name: string, spec: QuerySpec) => invoke<void>("query_view_save", { notebook, name, spec });
export const deleteQueryView = (notebook: string, name: string) => invoke<void>("query_view_delete", { notebook, name });
export const viewsQuery = (notebook: string) => ({ queryKey: ["query-views", notebook], queryFn: () => queryViews(notebook) });

/** The text that puts a query in a page: a fenced block the Reading view draws. */
export const queryBlock = (spec: QuerySpec) => `\`\`\`query\n${specJson(spec)}\n\`\`\`\n`;
