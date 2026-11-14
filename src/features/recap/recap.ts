// Pure helpers for the Recap page, which draws the result of Living Memory's `recap` command.
import type { Recap, RecapChange, RecapGroup } from "../../lib/lm";

/** The order the page lists change groups in. */
export const GROUP_ORDER: RecapGroup[] = ["created", "updated", "resolved", "superseded", "archived", "restored", "deleted"];
export const DAY_CHOICES = [7, 14, 30] as const;

/** The non-empty change groups in display order, each with its notes and how many times they changed. */
export function changeGroups(r: Pick<Recap, "changes">): { group: RecapGroup; items: RecapChange[]; total: number }[] {
  return GROUP_ORDER.flatMap((group) => {
    const items = r.changes[group] ?? [];
    return items.length ? [{ group, items, total: items.reduce((n, c) => n + c.count, 0) }] : [];
  });
}

/** "Claude 4, Codex 2", most sessions first. */
export function harnessLine(by: Record<string, number>): string {
  return Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([h, n]) => `${h.charAt(0).toUpperCase()}${h.slice(1)} ${n}`).join(", ");
}

/** "3 times" for a note that changed more than once, else nothing. */
export const repeatLabel = (count: number) => (count > 1 ? `${count} times` : "");

/** Whether the recap has anything to show. */
export const isQuiet = (r: Recap) =>
  !Object.keys(r.changes).length && !r.maintenance.runs && !r.sessions.count && !r.open_work.notes && !r.review.due;
