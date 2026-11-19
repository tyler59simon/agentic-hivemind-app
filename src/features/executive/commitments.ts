// Commitments are Living Memory action items written `Send the Q3 plan (owner: Dana, due: 2026-11-25)`, on a project's
// "Commitments: <Project>" plan note or any other plan, risk or bug note. This file reads and writes that convention.
import type { OpenItem } from "../../lib/lm";

export interface Commitment { task: string; owner: string; due: string }
export type Timing = "overdue" | "soon" | "later" | "undated";

const TAIL = /\s*\(([^()]*\b(?:owner|due)\s*:[^()]*)\)\s*$/i;

/** Split an action item into its task, owner and due date. Text without the trailing parentheses is all task. */
export function parseCommitment(item: string): Commitment {
  const m = item.match(TAIL);
  if (!m) return { task: item.trim(), owner: "", due: "" };
  const field = (name: string) => m[1].split(",").map((p) => p.trim()).find((p) => p.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const due = field("due");
  return { task: item.slice(0, m.index).trim(), owner: field("owner"), due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : "" };
}

export function formatCommitment(c: Commitment): string {
  const parts = [c.owner.trim() && `owner: ${c.owner.trim()}`, c.due && `due: ${c.due}`].filter(Boolean);
  return parts.length ? `${c.task.trim()} (${parts.join(", ")})` : c.task.trim();
}

/** Today in local time as YYYY-MM-DD. */
export const isoToday = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoToday(d);
};

/** Overdue before today, soon within `soonDays`, later after that. */
export function timing(due: string, today: string, soonDays = 7): Timing {
  if (!due) return "undated";
  if (due < today) return "overdue";
  return due <= addDays(today, soonDays) ? "soon" : "later";
}

export interface CommitmentRow extends Commitment { ref: string; index: number; note: string; timing: Timing }

/** Open action items as commitments, overdue first, then by due date; undated last. */
export function commitmentRows(items: OpenItem[], today: string): CommitmentRow[] {
  const order: Record<Timing, number> = { overdue: 0, soon: 1, later: 2, undated: 3 };
  return items
    .map((i) => {
      const c = parseCommitment(i.item);
      return { ...c, ref: i.ref, index: i.index, note: i.title, timing: timing(c.due, today) };
    })
    .sort((a, b) => order[a.timing] - order[b.timing] || a.due.localeCompare(b.due));
}

/** The title of a project's commitments note. */
export const commitmentsTitle = (projectName: string) => `Commitments: ${projectName}`;
