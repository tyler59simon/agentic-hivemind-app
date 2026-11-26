// The rows of the Tasks view (NS-7B) and how they are filtered, ordered and grouped. Pure, so the view only draws.
import { fieldsOf, priorityRank, type Priority } from "./tasks";

/** A line of a page, or an open action item of a Living Memory work note. */
export interface TaskItem {
  id: string;
  kind: "line" | "action";
  /** The container id of a page's notebook; for an action item, its domain. */
  notebook: string;
  notebookTitle: string;
  /** The page's path; for an action item, the note's title. */
  path: string;
  title: string;
  line: number;
  done: boolean;
  text: string;
  due: string | null;
  priority: Priority | null;
  /** The owner a task's tail names, if any. */
  owner?: string | null;
  /** A folder notebook's page hash when it was indexed (a write checks it). */
  sha256?: string;
  /** An action item's note ref and the index of its item in the note. */
  ref?: string;
  index?: number;
  /** An action item's note revision when it was listed (a tick sends it). */
  revision?: string;
  /** An action item's note was last updated (ISO), for ordering Home's undated groups. */
  updated?: string;
}

export type DueFilter = "any" | "overdue" | "today" | "week" | "none";
export type DoneFilter = "open" | "done" | "all";
export type Grouping = "none" | "page" | "due" | "notebook";

export interface TaskFilters { notebook: string; due: DueFilter; done: DoneFilter; text: string }

/** `day` plus `n` days, as `YYYY-MM-DD` (local dates, with no time zone in them). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  const two = (v: number) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** Where a task's due date stands against `today`: overdue, today, this week (the next six days), later, or none. */
export function dueBucket(due: string | null, today: string): "overdue" | "today" | "week" | "later" | "none" {
  if (!due) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 6) ? "week" : "later";
}

/** An item from a task line's text and what an index row said of it. */
export function itemOf(base: Omit<TaskItem, "due" | "priority" | "owner">, due: string | null): TaskItem {
  const fields = fieldsOf(base.text);
  return { ...base, due: due ?? fields.due, priority: fields.priority, owner: fields.owner };
}

export function filterTasks(items: TaskItem[], f: TaskFilters, today: string): TaskItem[] {
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((t) => {
    if (f.done === "open" && t.done) return false;
    if (f.done === "done" && !t.done) return false;
    if (f.notebook && (f.notebook === "@actions" ? t.kind !== "action" : t.kind === "action" || t.notebook !== f.notebook)) return false;
    if (f.due !== "any") {
      const bucket = dueBucket(t.due, today);
      // An overdue task that is done is not overdue any more.
      if (f.due === "overdue" ? bucket !== "overdue" || t.done : f.due === "week" ? bucket !== "week" && bucket !== "today" : bucket !== f.due) return false;
    }
    const hay = `${t.text} ${t.title}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Open before done, then by due date (none last), priority, notebook, page and line: the order Living Memory's `doc tasks` had, with the
 *  priority added. */
export function sortTasks(items: TaskItem[]): TaskItem[] {
  return [...items].sort((a, b) =>
    Number(a.done) - Number(b.done)
    || Number(a.due === null) - Number(b.due === null)
    || (a.due ?? "").localeCompare(b.due ?? "")
    || priorityRank(a.priority) - priorityRank(b.priority)
    || a.notebookTitle.localeCompare(b.notebookTitle)
    || a.path.localeCompare(b.path)
    || a.line - b.line);
}

export interface TaskGroup { key: string; label: string; items: TaskItem[] }

const DUE_LABELS: Record<string, string> = { overdue: "Overdue", today: "Today", week: "This week", later: "Later", none: "No due date" };
const DUE_ORDER = ["overdue", "today", "week", "later", "none"];

/** The items in the order given, in groups of one page, one notebook or one due bucket (in that order); one group, with no
 *  label, for no grouping. */
export function groupTasks(items: TaskItem[], by: Grouping, today: string): TaskGroup[] {
  if (by === "none") return [{ key: "", label: "", items }];
  const groups = new Map<string, TaskGroup>();
  for (const t of items) {
    const [key, label] = by === "page" ? [`${t.notebook}:${t.path}`, t.title || t.path]
      : by === "notebook" ? [t.notebook, t.notebookTitle]
      : [dueBucket(t.due, today), DUE_LABELS[dueBucket(t.due, today)]];
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(t);
    groups.set(key, group);
  }
  const out = [...groups.values()];
  return by === "due" ? out.sort((a, b) => DUE_ORDER.indexOf(a.key) - DUE_ORDER.indexOf(b.key)) : out;
}
