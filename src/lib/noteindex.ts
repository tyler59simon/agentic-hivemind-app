// The search index of folder notebooks (NS-4A): the Tauri commands of src-tauri/src/notes_index. The index holds pages,
// not Living Memory notes or Living Memory notebook pages; those are searched through Living Memory.
import { invoke } from "@tauri-apps/api/core";

/** The index marks the matches in a title or a snippet with these two characters, so page text never becomes markup. */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

export type PageKind = "md" | "hmdoc" | "canvas" | "txt";

export interface IndexHit {
  notebook: string; path: string; kind: PageKind; title: string; titleMarked: string; mtimeMs: number; snippet: string;
}
export interface IndexFilters {
  notebook?: string;
  /** Every notebook but this one. */
  excludeNotebook?: string;
  folder?: string;
  tag?: string;
  kind?: PageKind;
  modifiedAfterMs?: number;
}
/** How meaning search stood for a search: `off` when it was not asked for, `missing` when the Living Memory model is not
 *  installed, `building` while the pages are still being read into the index, `error` when the model cannot be read. */
export type MeaningState = "off" | "ready" | "building" | "missing" | "error";
export interface IndexSearch { hits: IndexHit[]; ms: number; state: "idle" | "scanning"; meaning?: MeaningState }
/** The pages nearest in meaning to a page, and the words to look for related memory notes with. */
export interface RelatedPages { pages: IndexHit[]; query: string; meaning: MeaningState }

export interface OutgoingLink { raw: string; kind: "wiki" | "md" | "file"; embed: boolean; line: number; context: string }
/** A link some page wrote whose target is named like the page asked about. Whether it reaches that page is for the
 *  resolver to say. `sha256` is the page's hash when it was indexed. */
export interface IncomingLink extends OutgoingLink { notebook: string; path: string; sha256: string }
export interface Mention { notebook: string; path: string; title: string; snippet: string }
export interface IndexLinks { outgoing: OutgoingLink[]; incoming: IncomingLink[]; unlinked: Mention[] }

export interface IndexedPage { notebook: string; path: string; kind: PageKind; title: string; mtimeMs: number }
export interface TagCount { tag: string; count: number }

/** `phase` says what `scanning` is doing: reading `pages`, or making the vectors for `meaning` search. */
export interface IndexProgress { state: "idle" | "scanning"; phase?: "pages" | "meaning"; done: number; total: number; error: string | null }
export interface SemanticStatus { state: "missing" | "building" | "ready" | "error"; model: string | null; error: string | null; full: boolean }
export interface IndexStatus extends IndexProgress { pages: number; notebooks: { id: string; pages: number }[]; version: number; semantic?: SemanticStatus }

export const indexSearch = (query: string, filters: IndexFilters = {}, limit = 30, meaning = false) =>
  invoke<IndexSearch>("index_search", { query, filters, limit, ...(meaning ? { meaning: true } : {}) }).then((r) => r ?? { hits: [], ms: 0, state: "idle" as const });
export const indexRelated = (notebook: string, path: string) =>
  invoke<RelatedPages>("index_related", { notebook, path }).then((r) => r ?? { pages: [], query: "", meaning: "off" as const });
export const indexLinks = (notebook: string, path: string) =>
  invoke<IndexLinks>("index_links", { notebook, path }).then((r) => ({ outgoing: r?.outgoing ?? [], incoming: r?.incoming ?? [], unlinked: r?.unlinked ?? [] }));
export const indexIncoming = (paths: string[]) => invoke<IncomingLink[]>("index_incoming", { paths }).then((r) => r ?? []);
export const indexPages = (notebook?: string) => invoke<IndexedPage[]>("index_pages", { notebook: notebook ?? null }).then((r) => r ?? []);
export const indexTags = (notebook?: string) => invoke<TagCount[]>("index_tags", { notebook: notebook ?? null }).then((r) => r ?? []);
export const indexStatus = () => invoke<IndexStatus>("index_status");
export const indexRebuild = (notebook?: string) => invoke<void>("index_rebuild", { notebook: notebook ?? null });

/** Every query that reads the index is keyed under this, so one invalidation refreshes them all. */
export const INDEX_KEY = "index";
export const pagesQuery = () => ({ queryKey: [INDEX_KEY, "pages"], queryFn: () => indexPages(), staleTime: 30_000 });
export const tagsQuery = () => ({ queryKey: [INDEX_KEY, "tags"], queryFn: () => indexTags() });
export const statusQuery = () => ({ queryKey: [INDEX_KEY, "status"], queryFn: indexStatus });
export const relatedQuery = (notebook: string, path: string) => ({ queryKey: [INDEX_KEY, "related", notebook, path], queryFn: () => indexRelated(notebook, path) });
export const linksQuery = (notebook: string, path: string) => ({ queryKey: [INDEX_KEY, "links", notebook, path], queryFn: () => indexLinks(notebook, path) });

/** A title or snippet split at the index's marks: the pieces, with `on` set for the matched ones. */
export function marked(text: string): { text: string; on: boolean }[] {
  const out: { text: string; on: boolean }[] = [];
  let on = false;
  for (const piece of text.split(new RegExp(`([${MARK_OPEN}${MARK_CLOSE}])`))) {
    if (piece === MARK_OPEN) on = true;
    else if (piece === MARK_CLOSE) on = false;
    else if (piece) out.push({ text: piece, on });
  }
  return out;
}

/** The words of a search, read as the index reads them (`fts_query` in `notes_index/query.rs`): words and quoted phrases;
 *  the last bare word, or one ending in `*`, matches as a prefix. Terms with no letter or digit are left out. */
export function queryTerms(input: string): { text: string; phrase: boolean; prefix: boolean }[] {
  const terms: { text: string; phrase: boolean }[] = [];
  let word = "", quoted = false;
  const flush = (phrase: boolean) => { if (/[\p{L}\p{N}]/u.test(word)) terms.push({ text: word, phrase }); word = ""; };
  for (const ch of input) {
    if (ch === '"') { flush(quoted); quoted = !quoted; }
    else if (/\s/.test(ch) && !quoted) flush(false);
    else word += ch;
  }
  flush(quoted);
  return terms.map((t, i) => ({ phrase: t.phrase, text: t.text.replace(/\*+$/, ""), prefix: !t.phrase && (i === terms.length - 1 || t.text.endsWith("*")) }));
}

/** `text` with the words of `query` marked as the index marks its matches, for results that come unmarked (Living Memory
 *  pages). Case does not matter; a word matches whole, the last one as a prefix, a phrase with any spacing. */
export function markWords(text: string, query: string): string {
  const plain = text.split(MARK_OPEN).join("").split(MARK_CLOSE).join("");
  const ranges: [number, number][] = [];
  for (const term of queryTerms(query)) {
    const body = term.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    if (!body) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${term.prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "giu");
    for (const m of plain.matchAll(re)) if (m[0]) ranges.push([m.index!, m.index! + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "", at = 0;
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  for (const [from, to] of merged) { out += plain.slice(at, from) + MARK_OPEN + plain.slice(from, to) + MARK_CLOSE; at = to; }
  return out + plain.slice(at);
}
