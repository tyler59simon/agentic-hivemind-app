import type { NoteRow, NoteType, OpenItem, TimelineResult } from "../../lib/lm";

export interface TimelineEntry { ref: string; date: string; type: NoteType; title: string; status: string }

/** Group open items by note, keeping LM's order (newest note first, items in note order). */
export function groupOpenItems(items: OpenItem[]): { ref: string; title: string; type: NoteType; items: OpenItem[] }[] {
  const groups = new Map<string, { ref: string; title: string; type: NoteType; items: OpenItem[] }>();
  for (const it of items) {
    let g = groups.get(it.ref);
    if (!g) { g = { ref: it.ref, title: it.title, type: it.type, items: [] }; groups.set(it.ref, g); }
    g.items.push(it);
  }
  return [...groups.values()];
}

/** A `review_by` value for `days` from today: YYYY-MM-DD in local time. */
export function snoozeDate(days: number, today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const newestFirst = (a: TimelineEntry, b: TimelineEntry) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

export const fromTimeline = (result: TimelineResult): TimelineEntry[] =>
  result.notes.map(({ ref, date, type, title, status }) => ({ ref, date, type, title, status })).sort(newestFirst);

export const toTimeline = (rows: NoteRow[], by: "updated" | "created"): TimelineEntry[] =>
  rows.map((r) => ({ ref: r.ref, date: r[by], type: r.type, title: r.title, status: r.status })).sort(newestFirst);

/** Scope options for open/review. All domains needs API 2; on API 1 fall back to a concrete domain. */
export function workScope(api: number, domain: string | "*"): { domain?: string; allDomains?: boolean } {
  if (domain === "*") return api >= 2 ? { allDomains: true } : {};
  return { domain };
}
