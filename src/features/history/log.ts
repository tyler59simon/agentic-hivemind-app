// Pure helpers for the History view, which lists rows of Living Memory's `log` command.
import type { LogRow } from "../../lib/lm";
import { dayLabel } from "./activity";

export const LOG_EVENTS = ["created", "updated", "confirmed", "superseded", "resolved", "archived", "reopened", "deleted", "promoted", "moved", "undone", "stage", "closed", "session"] as const;

/** Rows grouped by local day, in the order given (the store sends newest first). */
export function groupByDay(rows: LogRow[], now = new Date()): { label: string; rows: LogRow[] }[] {
  const days: { label: string; rows: LogRow[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.time, now);
    const last = days[days.length - 1];
    if (last?.label === label) last.rows.push(r);
    else days.push({ label, rows: [r] });
  }
  return days;
}

/** What a click on a row opens: a note, a change, or nothing (sessions and rows without a usable ref). */
export type LogTarget = { kind: "note"; ref: string } | { kind: "change"; id: number } | null;
export function targetOf(row: Pick<LogRow, "event" | "ref">): LogTarget {
  if (row.event === "session") return null;
  const change = /^CHG-0*(\d+)$/i.exec(row.ref);
  if (change) return { kind: "change", id: Number(change[1]) };
  return /^[^:\s]+:\S+$/.test(row.ref) ? { kind: "note", ref: row.ref } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Claude, 3 notes saved, 5 files changed" for a session row. */
export function sessionLine(row: Pick<LogRow, "harness" | "notes" | "files">): string {
  return [row.harness, plural(row.notes?.length ?? 0, "note saved", "notes saved"), plural(row.files ?? 0, "file changed", "files changed")]
    .filter(Boolean).join(", ");
}
