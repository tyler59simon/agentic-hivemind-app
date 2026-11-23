// Pure helpers for the review worklist. Every store sends `notes` and `due`; newer ones add `counts` and give each row its kinds, reason and action.
import { REVIEW_KINDS, type ReviewKind, type ReviewResult, type ReviewRow } from "../../lib/lm";
import type { InboxKind } from "../../store";

/** The rows to show (a newer store's rows carry kinds, reason and action). */
export const worklistRows = (result: ReviewResult | undefined): ReviewRow[] => result?.notes ?? [];

/** Kinds that have at least one row, in the store's order, plus any in `keep` so a picked kind stays visible at zero.
 *  Empty for an old store (no `counts`). */
export function kindCounts(counts: ReviewResult["counts"], keep: ReviewKind[] = []): { kind: ReviewKind; count: number }[] {
  if (!counts) return [];
  return REVIEW_KINDS.filter((k) => counts[k] > 0 || keep.includes(k)).map((kind) => ({ kind, count: counts[kind] }));
}

/** "2 stale, 3 due, 1 duplicate"; empty when nothing is counted. */
export const countLine = (counts: ReviewResult["counts"]): string =>
  kindCounts(counts).map(({ kind, count }) => `${count} ${kind}`).join(", ");

export type PrimaryKind = "confirm" | "open" | "resolve" | "archive" | "merge";
export interface Primary { kind: PrimaryKind; label: string }

/** The first button of a row. A row without an action behaves as before ("Still true"); a merge needs the other note. */
export function primaryAction(row: Pick<ReviewRow, "action" | "pair">): Primary {
  switch (row.action) {
    case "update": return { kind: "open", label: "Open" };
    case "resolve": return { kind: "resolve", label: "Resolve…" };
    case "archive": return { kind: "archive", label: "Archive…" };
    case "merge-plan":
    case "supersede": return row.pair ? { kind: "merge", label: "Merge…" } : { kind: "open", label: "Open" };
    default: return { kind: "confirm", label: "Still true" };
  }
}

/** How many of the rows carry each kind (a row may carry several). Used where the store's own counts would include notes the
 *  list leaves out. */
export function countKinds(rows: ReviewRow[]): Record<ReviewKind, number> {
  const counts = Object.fromEntries(REVIEW_KINDS.map((k) => [k, 0])) as Record<ReviewKind, number>;
  for (const row of rows) for (const k of new Set(row.kinds ?? [])) counts[k] += 1;
  return counts;
}

// ---- The Inbox's groups. ----

export const INBOX_GROUPS: { id: InboxKind; label: string }[] = [
  { id: "code", label: "Code" }, { id: "memory", label: "Memory" }, { id: "pages", label: "Pages" }, { id: "captures", label: "Captures" },
  { id: "maintenance", label: "Maintenance" }, { id: "architecture", label: "Architecture" }, { id: "skills", label: "Skills" },
];
export type InboxCounts = Record<InboxKind, number>;
export const NO_COUNTS: InboxCounts = { code: 0, memory: 0, pages: 0, captures: 0, maintenance: 0, architecture: 0, skills: 0 };

/** What the sidebar badge and the All tab show: every group's count added up. */
export const inboxTotal = (counts: InboxCounts): number => INBOX_GROUPS.reduce((sum, g) => sum + counts[g.id], 0);

/** The tabs: All, then each group that has something waiting. */
export const inboxTabs = (counts: InboxCounts): { id: "all" | InboxKind; label: string; count: number }[] => [
  { id: "all", label: "All", count: inboxTotal(counts) },
  ...INBOX_GROUPS.filter((g) => counts[g.id] > 0).map((g) => ({ id: g.id, label: g.label, count: counts[g.id] })),
];

/** The group to show: the one asked for, or All when it has nothing left (a decision just emptied it). */
export const shownKind = (kind: "all" | InboxKind, counts: InboxCounts): "all" | InboxKind => (kind === "all" || counts[kind] > 0 ? kind : "all");
