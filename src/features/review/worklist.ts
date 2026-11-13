// Pure helpers for the review worklist. Older stores send only `notes` and `due`; newer ones add `items`, `counts` and `total`.
import { REVIEW_KINDS, type ReviewKind, type ReviewResult, type ReviewRow } from "../../lib/lm";

/** The rows to show: the richer worklist when the store sends one, else the notes that are due. */
export const worklistRows = (result: ReviewResult | undefined): ReviewRow[] => result?.items ?? result?.notes ?? [];

/** Kinds that have at least one row, in the store's order. Empty for an old store (no `counts`). */
export function kindCounts(counts: ReviewResult["counts"]): { kind: ReviewKind; count: number }[] {
  if (!counts) return [];
  return REVIEW_KINDS.filter((k) => counts[k] > 0).map((kind) => ({ kind, count: counts[kind] }));
}

/** "2 stale, 3 due, 1 duplicate"; empty when nothing is counted. */
export const countLine = (counts: ReviewResult["counts"]): string =>
  kindCounts(counts).map(({ kind, count }) => `${count} ${kind}`).join(", ");

/** Rows with at least one of the picked kinds; no kinds picked shows everything. */
export const filterByKind = (rows: ReviewRow[], picked: ReviewKind[]): ReviewRow[] =>
  picked.length ? rows.filter((r) => r.kinds?.some((k) => picked.includes(k))) : rows;

export type PrimaryKind = "confirm" | "open" | "resolve" | "archive" | "merge";
export interface Primary { kind: PrimaryKind; label: string }

/** The first button of a row. A row without an action behaves as before ("Still true"); a merge needs the other note. */
export function primaryAction(row: Pick<ReviewRow, "action" | "pair">): Primary {
  switch (row.action) {
    case "update": return { kind: "open", label: "Open" };
    case "resolve": return { kind: "resolve", label: "Resolve…" };
    case "archive-plan": return { kind: "archive", label: "Archive…" };
    case "merge-plan":
    case "supersede": return row.pair ? { kind: "merge", label: "Merge…" } : { kind: "open", label: "Open" };
    default: return { kind: "confirm", label: "Still true" };
  }
}
