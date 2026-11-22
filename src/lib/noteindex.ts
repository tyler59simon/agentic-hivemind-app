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
export interface IndexSearch { hits: IndexHit[]; ms: number; state: "idle" | "scanning" }

export interface OutgoingLink { raw: string; kind: "wiki" | "md" | "file"; embed: boolean; line: number; context: string }
/** A link some page wrote whose target is named like the page asked about. Whether it reaches that page is for the
 *  resolver to say. `sha256` is the page's hash when it was indexed. */
export interface IncomingLink extends OutgoingLink { notebook: string; path: string; sha256: string }
export interface Mention { notebook: string; path: string; title: string; snippet: string }
export interface IndexLinks { outgoing: OutgoingLink[]; incoming: IncomingLink[]; unlinked: Mention[] }

export interface IndexedPage { notebook: string; path: string; kind: PageKind; title: string; mtimeMs: number }
export interface TagCount { tag: string; count: number }

export interface IndexProgress { state: "idle" | "scanning"; done: number; total: number; error: string | null }
export interface IndexStatus extends IndexProgress { pages: number; notebooks: { id: string; pages: number }[]; version: number }

export const indexSearch = (query: string, filters: IndexFilters = {}, limit = 30) =>
  invoke<IndexSearch>("index_search", { query, filters, limit }).then((r) => r ?? { hits: [], ms: 0, state: "idle" as const });
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
