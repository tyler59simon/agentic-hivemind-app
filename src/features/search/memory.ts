// Pure helpers for Memory note searching and filtering in the unified top-bar search box (CON-11).
import type { NoteRow, NoteType, SearchHit, SearchOptions, Status } from "../../lib/lm";

export type MemoryStatus = "active" | "archived" | "any";

export interface MemoryItem {
  ref: string;
  domain: string;
  title: string;
  type: NoteType;
  status: Status;
  tags: string[];
  updated: string;
  snippet: string;
  relevance?: number;
  similarity?: number;
}

export const MEMORY_DISPLAY_LIMIT = 25;

/** Living Memory `search` may return a bare id or a `domain:id` ref depending on caller/mock. */
export const hitRef = (h: Pick<SearchHit, "id" | "domain">) => (h.id.includes(":") ? h.id : `${h.domain}:${h.id}`);

export const fromSearchHit = (h: SearchHit): MemoryItem => ({
  ref: hitRef(h),
  domain: h.domain,
  title: h.title,
  type: h.type,
  status: h.status,
  tags: h.tags ?? [],
  updated: h.updated ?? "",
  snippet: h.snippet ?? "",
  relevance: h.relevance,
  similarity: h.similarity,
});

export const fromNoteRow = (r: NoteRow): MemoryItem => ({
  ref: r.ref,
  domain: r.domain,
  title: r.title,
  type: r.type,
  status: r.status,
  tags: r.tags ?? [],
  updated: r.updated ?? "",
  snippet: r.summary ?? "",
});

/** Build `alm search` options: searches all domains (domains are hidden), asking LM to filter what it can and widening
 *  the limit when archive status or a second tag is filtered client-side. */
export function memorySearchOptions(f: {
  query: string;
  domain: string;
  status: MemoryStatus;
  noteType: string;
  tag: string;
  projectTag?: string;
}): SearchOptions {
  const filteredHere = f.status === "archived" || (!!f.tag && !!f.projectTag);
  return {
    query: f.query,
    domain: f.domain,
    scope: "all",
    type: f.noteType || undefined,
    status: f.status === "active" ? "active" : undefined,
    tag: f.tag || f.projectTag || undefined,
    limit: filteredHere ? 60 : MEMORY_DISPLAY_LIMIT,
  };
}

export interface MemoryFilter {
  status: MemoryStatus;
  noteType: string;
  tags: string[];
}

export function filterMemoryItems(items: MemoryItem[], f: MemoryFilter): MemoryItem[] {
  return items.filter((n) =>
    (!f.noteType || n.type === f.noteType)
    && (f.status === "any" || (f.status === "active" ? n.status === "active" : n.status !== "active"))
    && f.tags.every((t) => n.tags.includes(t)),
  );
}

/** Newest updated first (for filter-only browsing when no search query was typed). */
export const byUpdatedDesc = (items: MemoryItem[]) => [...items].sort((a, b) => b.updated.localeCompare(a.updated));

/** Project label for a memory note (from its `project/` tag), or "Unassigned" when projects are known. */
export function memoryProjectLabel(tags: string[], projectNames?: Map<string, string>): string | null {
  if (!projectNames || !projectNames.size) return null;
  for (const tag of tags) {
    const name = projectNames.get(tag);
    if (name) return name;
  }
  return "Unassigned";
}
