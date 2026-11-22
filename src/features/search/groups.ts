// The results of the Notes page's search box, grouped by where they come from (NS-4A). Scores of different origins are
// never compared: each group keeps the order its own source gave, and a group is as long as its source made it.
import type { FileRef } from "../../documents/keys";
import type { DocNotebook, DocSearchHit, SearchHit } from "../../lib/lm";
import { markWords, type IndexHit } from "../../lib/noteindex";

/** The cosine at which a result found by meaning counts: `min_similarity` of Living Memory's model. */
export const MIN_SIMILARITY = 0.45;

/** Living Memory can return every page or note after the real hits, with relevance 0 (and, with its semantic search on, a
 *  low similarity). A notebook page is real when it matched words (relevance above 0) or is near in meaning (similarity at
 *  the floor or above). */
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

export type GroupId = "here" | "other" | "lm" | "memory";

export type Target = { page: FileRef } | { lm: { domain: string; notebook: string; path: string } } | { note: { ref: string; domain: string; title: string } };

export interface ResultRow {
  key: string;
  group: GroupId;
  title: string;
  /** The title with the index's match marks, when it has any. */
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
  /** Whether Living Memory can search notebook pages (`docs.search`); without it the group is absent whatever `lm` holds. */
  lmSearch: boolean;
  lm: DocSearchHit[];
  /** The Living Memory notebooks Hivemind lists, the only ones a tab can open. */
  lmNotebooks: Pick<DocNotebook, "domain" | "notebook">[];
  memory: SearchHit[];
  /** What was typed: Living Memory's page snippets carry no marks, so its words are marked here. */
  query?: string;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function pageRow(hit: IndexHit, group: GroupId, titles: Map<string, string>, showNotebook: boolean): ResultRow {
  const detail = [showNotebook ? titles.get(hit.notebook) ?? hit.notebook : "", folderOf(hit.path)].filter(Boolean).join(" · ");
  return {
    key: `page:${hit.notebook}:${hit.path}`, group, title: hit.title, marked: hit.titleMarked, detail, snippet: hit.snippet || undefined,
    open: { page: { notebook: hit.notebook, path: hit.path } },
  };
}

/** The groups that have rows, in the order they are shown. */
export function buildGroups(input: GroupInput): Group[] {
  const groups: Group[] = [];
  const add = (id: GroupId, title: string, rows: ResultRow[]) => { if (rows.length) groups.push({ id, title, rows }); };
  add("here", "This notebook", input.here.map((h) => pageRow(h, "here", input.titles, false)));
  add("other", input.current ? "Other notebooks" : "Notebooks", input.other.map((h) => pageRow(h, "other", input.titles, true)));
  if (input.lmSearch) {
    const known = new Set(input.lmNotebooks.map((n) => `${n.domain}\n${n.notebook}`));
    const rows: ResultRow[] = [];
    for (const hit of input.lm) {
      if (!known.has(`${hit.domain}\n${hit.notebook}`) || !isRelevantPage(hit)) continue;
      rows.push({
        key: `lm:${hit.domain}:${hit.notebook}:${hit.path}:${hit.line_start}`, group: "lm", title: hit.title, detail: [hit.notebook_title, hit.heading].filter(Boolean).join(" · "),
        snippet: input.query ? markWords(hit.snippet, input.query) : hit.snippet, open: { lm: { domain: hit.domain, notebook: hit.notebook, path: hit.path } },
      });
    }
    add("lm", "Living Memory pages", rows);
  }
  add("memory", "Memory notes", input.memory.map((n) => ({
    key: `note:${n.id}`, group: "memory" as const, title: n.title, detail: `${n.domain} · ${n.type}`, snippet: n.snippet || undefined,
    open: { note: { ref: n.id, domain: n.domain, title: n.title } },
  })));
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
