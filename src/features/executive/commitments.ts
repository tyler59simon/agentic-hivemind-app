// Commitments are Living Memory action items written `Send the Q3 plan (owner: Dana, due: 2026-11-25)`, on a project's
// "Commitments: <Project>" plan note or any other plan, risk or bug note. This file reads and writes that convention.
import type { OpenItem } from "../../lib/lm";
import { displayText, fieldsOf } from "../notes/tasks";

export interface Commitment { task: string; owner: string; due: string }
export type Timing = "overdue" | "soon" | "later" | "undated";

/** Split an action item into its task, owner and due date, by the one rule `fieldsOf` holds (the tail, or a Tasks date mark). */
export function parseCommitment(item: string): Commitment {
  const f = fieldsOf(item);
  return { task: displayText(item), owner: f.owner ?? "", due: f.due ?? "" };
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
