// The results of the unified top-bar search box, grouped by origin in one consistent order everywhere (NS-4A, CON-11):
// Memory notes, This notebook, Other notebooks / Notebooks. (Living Memory pages were a fourth group until CON-18 retired
// hosted notebooks on 2026-11-24.)
// Scores of different origins are never compared: each group keeps the order its own source gave.
import type { FileRef } from "../../documents/keys";
import type { SearchHit } from "../../lib/lm";
import { markWords, type IndexHit } from "../../lib/noteindex";
import { fromSearchHit, memoryProjectLabel, type MemoryItem } from "./memory";

/** The cosine at which a result found by meaning counts: `min_similarity` of Living Memory's model. */
export const MIN_SIMILARITY = 0.45;

/** Living Memory can return every note after the real hits, with relevance 0 (and, with its semantic search on, a low
 *  similarity). A result is real when it matched words (relevance above 0) or is near in meaning (similarity at the floor or
 *  above). */
export function isRelevantPage(hit: { relevance?: number; similarity?: number }): boolean {
  if (typeof hit.similarity === "number" && hit.similarity >= MIN_SIMILARITY) return true;
  return hit.relevance === undefined || hit.relevance > 0;
}

/** A memory note is related when its similarity reaches the floor; with Living Memory's semantic search off there is no
 *  similarity, and it is related when it matched words (relevance above 0). A result with neither field is kept. */
export function isRelatedNote(hit: { relevance?: number; similarity?: number }): boolean {
  if (typeof hit.similarity === "number") return hit.similarity >= MIN_SIMILARITY;
  return hit.relevance === undefined || hit.relevance > 0;
}

export type GroupId = "memory" | "here" | "other";

export type Target = { page: FileRef } | { note: { ref: string; domain: string; title: string } };

export interface ResultRow {
  key: string;
  group: GroupId;
  title: string;
  /** The title with match marks, when it has any. */
  marked?: string;
  detail: string;
  snippet?: string;
  open: Target;
}

export interface Group { id: GroupId; title: string; rows: ResultRow[] }

export interface GroupInput {
  /** The notebook of the page being read, when there is one. */
  current?: string;
  /** Registered folder notebooks, for the detail line. */
  titles: Map<string, string>;
  here: IndexHit[];
  other: IndexHit[];
  /** Matching Memory notes (from `alm search` or `alm list`). */
  memory: (SearchHit | MemoryItem)[];
  /** Project tag (`project/<slug>`) -> project name, so Memory rows show project names instead of raw domain names. */
  projectNames?: Map<string, string>;
  /** What was typed: used to highlight matches in Living Memory note titles and snippets. */
  query?: string;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function pageRow(hit: IndexHit, group: GroupId, titles: Map<string, string>, showNotebook: boolean): ResultRow {
  const detail = [showNotebook ? titles.get(hit.notebook) ?? hit.notebook : "", folderOf(hit.path)].filter(Boolean).join(" · ");
  return {
    key: `page:${hit.notebook}:${hit.path}`, group, title: hit.title, marked: hit.titleMarked, detail, snippet: hit.snippet || undefined,
    open: { page: { notebook: hit.notebook, path: hit.path } },
  };
}

function asMemoryItem(n: SearchHit | MemoryItem): MemoryItem {
  return "ref" in n ? n : fromSearchHit(n);
}

/** The groups that have rows, in one consistent order everywhere: Memory notes, This notebook, Other notebooks / Notebooks. */
export function buildGroups(input: GroupInput): Group[] {
  const groups: Group[] = [];
  const add = (id: GroupId, title: string, rows: ResultRow[]) => { if (rows.length) groups.push({ id, title, rows }); };
  const q = input.query?.trim() || "";

  const memRows: ResultRow[] = [];
  for (const raw of input.memory) {
    const n = asMemoryItem(raw);
    if (q && !isRelevantPage(n)) continue;
    const where = memoryProjectLabel(n.tags, input.projectNames) ?? n.domain;
    const detail = [where, n.type, n.status && n.status !== "active" ? n.status : ""].filter(Boolean).join(" · ");
    const snippet = n.snippet ? oneLine(n.snippet) : "";
    memRows.push({
      key: `note:${n.ref}`,
      group: "memory",
      title: n.title,
      marked: q ? markWords(n.title, q) : undefined,
      detail,
      snippet: snippet ? (q ? markWords(snippet, q) : snippet) : undefined,
      open: { note: { ref: n.ref, domain: n.domain, title: n.title } },
    });
  }
  add("memory", "Memory notes", memRows);

  add("here", "This notebook", input.here.map((h) => pageRow(h, "here", input.titles, false)));
  add("other", input.current ? "Other notebooks" : "Notebooks", input.other.map((h) => pageRow(h, "other", input.titles, true)));
  return groups;
}

/** Every row in the order the arrow keys walk them. */
export const flatRows = (groups: Group[]): ResultRow[] => groups.flatMap((g) => g.rows);

/** The row an arrow key moves to from `index`: it stops at both ends, and a list with nothing in it has no row. */
export function moveActive(index: number, key: string, count: number): number {
  if (count === 0) return -1;
  if (key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return index;
}

/** `modified` filter choices, as the time they reach back to, in milliseconds. */
export const MODIFIED = [
  { id: "any", label: "Any time", ms: 0 },
  { id: "day", label: "Past day", ms: 86_400_000 },
  { id: "week", label: "Past week", ms: 7 * 86_400_000 },
  { id: "month", label: "Past month", ms: 30 * 86_400_000 },
] as const;
