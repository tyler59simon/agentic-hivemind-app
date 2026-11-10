// Pure helpers for the Memory library: the type tabs, and one row shape for listed notes and search hits.
import type { NoteRow, NoteType, SearchHit, Status } from "../../lib/lm";
import type { Shelf } from "../../store";

export type Group = "decisions" | "knowledge" | "plans" | "risks" | "all";
/** The tabs over the list. Every note type belongs to exactly one group besides All. */
export const GROUPS: { id: Group; label: string; types: NoteType[] | null }[] = [
  { id: "decisions", label: "Decisions", types: ["decision"] },
  { id: "knowledge", label: "Knowledge", types: ["knowledge", "research", "context", "map", "policy", "preference", "runbook", "status"] },
  { id: "plans", label: "Plans", types: ["plan"] },
  { id: "risks", label: "Risks", types: ["risk", "bug"] },
  { id: "all", label: "All", types: null },
];

/** Where the library looks: the picked project, or a domain the way search scopes it. */
export type Scope = "project" | "fallback" | "active" | "all";

export interface Item {
  ref: string; title: string; type: NoteType; status: Status; domain: string; tags: string[];
  updated: string; text: string;
}

export const fromRow = (r: NoteRow): Item =>
  ({ ref: r.ref, title: r.title, type: r.type, status: r.status, domain: r.domain, tags: r.tags, updated: r.updated, text: r.summary ?? "" });
export const fromHit = (h: SearchHit): Item =>
  ({ ref: `${h.domain}:${h.id}`, title: h.title, type: h.type, status: h.status, domain: h.domain, tags: h.tags, updated: h.updated, text: h.snippet });

export interface Filter {
  group: Group; shelf: Shelf;
  /** Tags a note must all carry (the project's tag, the picked tag). */
  tags: string[];
  /** Domains a note may be in; null for any. */
  domains: string[] | null;
}

export function filterItems(items: Item[], f: Filter): Item[] {
  const types = GROUPS.find((g) => g.id === f.group)?.types ?? null;
  return items.filter((n) =>
    (!types || types.includes(n.type))
    && (f.shelf === "any" || (f.shelf === "active" ? n.status === "active" : n.status !== "active"))
    && f.tags.every((t) => n.tags.includes(t))
    && (!f.domains || f.domains.includes(n.domain)));
}

/** Newest first. */
export const byUpdated = (items: Item[]) => [...items].sort((a, b) => b.updated.localeCompare(a.updated));
