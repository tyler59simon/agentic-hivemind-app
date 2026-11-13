// What a dashboard does with a note's view model, mirrored from the page Living Memory writes (core/views.py):
// tag kinds and badge classes, the Open/Done/All tabs, chip and text filters, and the three sort orders.
import { wikilinks } from "../../lib/note";
import type { ViewItem, ViewModel, ViewRow } from "../../lib/lm";

/** The note ID of a ref (`domain:id`, or a bare ID). */
export const noteId = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

/** The model of a view whose note no longer exists, built from its registry row (LM cannot render a ref it cannot resolve). */
export const missingModel = (row: ViewRow): ViewModel => ({
  id: row.note, domain: row.domain, title: row.title ?? "Note not found", type: "", status: "missing", updated: "", revision: "",
  summary: "", important: null, items: [], sections: [], counts: { open: 0, done: 0, total: 0 }, superseded_by: null, view_title: row.title ?? undefined,
});

export type TagKind = "priority" | "status" | "other";
export type Tab = "open" | "done" | "all";
export type Sort = "written" | "priority" | "id";
export const TABS: { id: Tab; label: string }[] = [{ id: "open", label: "Open" }, { id: "done", label: "Done" }, { id: "all", label: "All" }];
export const SORTS: { id: Sort; label: string }[] = [{ id: "written", label: "Written order" }, { id: "priority", label: "Priority" }, { id: "id", label: "ID" }];

/** Status words. Living Memory's own page lacks the last five (tracked there as VIEW-2); Hivemind has them. */
const STATUS_WORDS = new Set([
  "approved", "active", "succeeded", "next", "proposed", "busy", "running", "waiting", "paused", "deprecated",
  "failed", "blocked", "done", "deferred", "conditional", "idea", "later", "check",
]);

/** A priority is P and one digit; a status is one of the words above; everything else (an area such as ALM) is other. */
export function tagKind(tag: string): TagKind {
  if (/^P\d$/i.test(tag)) return "priority";
  return STATUS_WORDS.has(tag.toLowerCase()) ? "status" : "other";
}

/** The colour class of a tag's badge, matching `.status-chip` in App.css; "" is the plain badge. */
export function badgeClass(tag: string): "bad" | "warn" | "p3" | "ok" | "next" | "" {
  switch (tag.toLowerCase()) {
    case "p1": case "failed": case "blocked": return "bad";
    case "p2": case "waiting": case "paused": case "deprecated": return "warn";
    case "p3": return "p3";
    case "approved": case "active": case "succeeded": return "ok";
    case "next": case "proposed": case "busy": case "running": return "next";
    default: return "";
  }
}

/** Open when anything is open, otherwise All (a finished note would otherwise open on an empty tab). */
export const defaultTab = (counts: ViewModel["counts"]): Tab => (counts.open ? "open" : "all");

export const tabCount = (counts: ViewModel["counts"], tab: Tab) => (tab === "open" ? counts.open : tab === "done" ? counts.done : counts.total);

/** The chips: every distinct tag grouped by kind (priority, status, other), each group sorted by name. */
export function chipGroups(items: readonly ViewItem[]): { kind: TagKind; tags: string[] }[] {
  const seen = new Set<string>();
  for (const it of items) for (const t of it.tags) seen.add(t);
  return (["priority", "status", "other"] as const)
    .map((kind) => ({ kind, tags: [...seen].filter((t) => tagKind(t) === kind).sort((a, b) => a.localeCompare(b)) }))
    .filter((g) => g.tags.length);
}

export interface Filters { tab: Tab; tags: ReadonlySet<string>; q: string }

/** An item passes when it is on the tab; has, for every kind with chips selected, at least one of that kind's selected
 *  tags (OR within a kind, AND across kinds); and contains the search text in its text, ID, tags or detail. */
export function passes(item: ViewItem, f: Filters): boolean {
  if (f.tab === "open" && item.done) return false;
  if (f.tab === "done" && !item.done) return false;
  const byKind = new Map<TagKind, string[]>();
  for (const t of f.tags) byKind.set(tagKind(t), [...(byKind.get(tagKind(t)) ?? []), t]);
  for (const want of byKind.values()) if (!want.some((t) => item.tags.includes(t))) return false;
  const q = f.q.trim().toLowerCase();
  if (q && ![item.text, item.id ?? "", item.tags.join(" "), item.detail ?? ""].join(" ").toLowerCase().includes(q)) return false;
  return true;
}

/** The lowest P-number among an item's tags; 99 when it has none. */
export function priorityOf(item: ViewItem): number {
  for (const t of item.tags) { const m = /^P(\d)$/i.exec(t); if (m) return Number(m[1]); }
  return 99;
}

/** Written order keeps the note's order; priority puts P1 first; id puts items with an ID first, in numeric-aware order. */
export function sortItems(items: readonly ViewItem[], sort: Sort): ViewItem[] {
  const out = [...items];
  if (sort === "priority") out.sort((a, b) => priorityOf(a) - priorityOf(b) || a.index - b.index);
  else if (sort === "id") {
    out.sort((a, b) => {
      if (!a.id !== !b.id) return a.id ? -1 : 1;
      return (a.id ?? "").localeCompare(b.id ?? "", undefined, { numeric: true }) || a.index - b.index;
    });
  }
  return out;
}

export const visibleItems = (items: readonly ViewItem[], f: Filters, sort: Sort) => sortItems(items.filter((i) => passes(i, f)), sort);

/** The line shown above a dashboard whose note is not a live one; null for an active note. */
export function noteBanner(m: Pick<ViewModel, "status" | "superseded_by">): string | null {
  const name = m.superseded_by;
  if (m.status === "missing") return "This note was not found. It may have been deleted or moved to another store. Remove this dashboard from the note's page or with views remove.";
  if (m.status === "superseded") return `This note was superseded${name ? ` by ${name}.` : "."}`;
  if (m.status === "resolved" || m.status === "archived") return `This note is ${m.status}.${name ? ` It was replaced by ${name}.` : ""}`;
  return null;
}

export type TextPart = { text: string } | { link: string; label: string };

/** Plain text with its [[Note]] links picked out, for text (a summary) that is not Markdown. */
export function linkParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const l of wikilinks(text)) {
    if (l.from > at) out.push({ text: text.slice(at, l.from) });
    out.push({ link: l.target, label: l.alias ?? (l.heading ? `${l.target} › ${l.heading}` : l.target) });
    at = l.to;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The selected chips that still exist in the items: a tag that left the note must not filter everything out. */
export function liveTags(items: readonly ViewItem[], selected: ReadonlySet<string>): Set<string> {
  const known = new Set(items.flatMap((i) => i.tags));
  return new Set([...selected].filter((t) => known.has(t)));
}
