// Home's pure part: which open items belong to a project, how they fall into the sections of the open list, and how far back the
// "since you were last here" section reads. The page passes in what its queries returned.
import type { Milestone } from "../../lib/executive";
import type { NoteRow, Project } from "../../lib/lm";
import type { Notebook } from "../../lib/notebooks";
import { itemsTagged, looseRefs } from "../executive/portfolio";
import type { InboxKind } from "../../store";
import { insideRepos } from "../projects/scope";
import { dueBucket, sortTasks, type TaskItem } from "../notes/taskList";
import type { InboxCounts } from "../review/worklist";

/** One row of the open list: a task with a due date, or a milestone. */
export type Entry =
  | { kind: "task"; due: string; task: TaskItem }
  | { kind: "milestone"; due: string; milestone: Milestone };

/** The undated items of one note or page: how many, and the first by priority. */
export interface UndatedGroup {
  key: string;
  title: string;
  /** The notebook or domain the note or page is in. */
  where: string;
  count: number;
  first: TaskItem;
  items: TaskItem[];
  /** The newest update of the group's items, for ordering; empty when no item says. */
  updated: string;
}

export interface HomeSections { overdue: Entry[]; today: Entry[]; week: Entry[]; later: Entry[]; undated: UndatedGroup[] }

/** The items of a project: action items of the notes that carry its tag, and tasks of pages in notebooks inside its repositories. */
export function projectItems(items: TaskItem[], project: Pick<Project, "tag" | "repos">, rows: NoteRow[], folders: Notebook[]): TaskItem[] {
  const inside = new Set(folders.filter((f) => insideRepos(f.path, project.repos)).map((f) => f.id));
  return [
    ...itemsTagged(items.filter((t) => t.kind === "action"), rows, project.tag),
    ...items.filter((t) => t.kind === "line" && inside.has(t.notebook)),
  ];
}

/** The action items on notes that belong to no project (the cross-project commitments note, mostly). */
export const looseItems = (items: TaskItem[], rows: NoteRow[]): TaskItem[] => {
  const loose = looseRefs(rows);
  return items.filter((t) => t.kind === "action" && t.ref !== undefined && loose.has(t.ref));
};

const groupKey = (t: TaskItem) => (t.kind === "action" ? t.ref! : `${t.notebook}:${t.path}`);

/** The open list: tasks and milestones that are not done, in five sections by due date (overdue, today, the next six days, later,
 *  and undated). Within a section they are in due-date order, tasks by `sortTasks` among those of one day. A milestone marked
 *  missed is overdue whatever its date; one with no date and not missed is left out. Undated tasks are grouped by note or page,
 *  the group with the newest update first. */
export function homeSections(items: TaskItem[], milestones: Milestone[], today: string): HomeSections {
  const out: HomeSections = { overdue: [], today: [], week: [], later: [], undated: [] };
  const tasks = sortTasks(items.filter((t) => !t.done));
  const entries: Entry[] = [
    ...tasks.filter((t) => t.due).map((t): Entry => ({ kind: "task", due: t.due!, task: t })),
    ...milestones.filter((m) => m.status !== "done" && (m.due || m.status === "missed")).map((m): Entry => ({ kind: "milestone", due: m.due, milestone: m })),
  ];
  // The sort is stable, so the order `sortTasks` gave stays within a day.
  for (const e of entries.sort((a, b) => (a.due || "").localeCompare(b.due || ""))) {
    const missed = e.kind === "milestone" && e.milestone.status === "missed";
    const bucket = missed ? "overdue" : dueBucket(e.due || null, today);
    if (bucket !== "none") out[bucket].push(e);
  }
  const groups = new Map<string, UndatedGroup>();
  for (const t of tasks.filter((t) => !t.due)) {
    const key = groupKey(t);
    const g = groups.get(key) ?? { key, title: t.title || t.path, where: t.notebookTitle, count: 0, first: t, items: [], updated: "" };
    g.items.push(t);
    g.count += 1;
    if ((t.updated ?? "") > g.updated) g.updated = t.updated ?? "";
    groups.set(key, g);
  }
  out.undated = [...groups.values()].sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
  return out;
}

/** What Home's list of open work says is due soon: overdue, today and this week. */
export const dueSoon = (s: HomeSections): Entry[] => [...s.overdue, ...s.today, ...s.week];

/** The Home route's names for who a visit was: `*` for all projects, else the project's slug. */
export const visitScope = (project: string | null | undefined) => project || "*";

const DAY = 86_400_000;
const VISIT_KEY = "hivemind.home.visit";

/** How many whole days the "since you were last here" section reads: from the last visit, never fewer than 1 or more than 90.
 *  A first visit reads a week. Living Memory's recap takes whole days only. */
export function sinceDays(last: number | null, now: number): number {
  if (last === null || !Number.isFinite(last)) return 7;
  return Math.min(90, Math.max(1, Math.ceil((now - last) / DAY)));
}

/** When this scope's Home was last left, in ms, or null when it never was or the browser keeps nothing. */
export function lastVisit(scope: string): number | null {
  try {
    const value = Number(localStorage.getItem(`${VISIT_KEY}.${scope}`));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function rememberVisit(scope: string, now = Date.now()) {
  try { localStorage.setItem(`${VISIT_KEY}.${scope}`, String(now)); } catch { /* not remembered */ }
}

/** A row of "Needs you" for something the Inbox holds, and the group it opens. */
export interface InboxRow { key: string; text: string; kind: InboxKind }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One row for each Inbox group that has something, except Captures (a row each, built by the page) and drafts/skills (which
 *  appear under agent needs). Includes unconfirmed agent-captured notes and architecture items so Home matches the Inbox badge. */
export function inboxNeeds(
  counts: InboxCounts,
  notesDue: number,
  extra: { unconfirmed?: number; archProposals?: number; archBehind?: number } = {},
): InboxRow[] {
  const out: InboxRow[] = [];
  if (counts.code) out.push({ key: "code", text: `${plural(counts.code, "proposed file change")}`, kind: "code" });
  if (extra.archProposals) out.push({ key: "arch-proposals", text: `${plural(extra.archProposals, "architecture update")} proposed`, kind: "architecture" });
  if (extra.archBehind) out.push({ key: "arch-behind", text: `${plural(extra.archBehind, "architecture snapshot")} behind`, kind: "architecture" });
  if (notesDue) out.push({ key: "due", text: `${plural(notesDue, "note")} due for review`, kind: "memory" });
  if (extra.unconfirmed) out.push({ key: "unconfirmed", text: `${plural(extra.unconfirmed, "agent note")} to confirm`, kind: "memory" });
  if (counts.pages) out.push({ key: "pages", text: `${plural(counts.pages, "page edit")} proposed by agents`, kind: "pages" });
  if (counts.maintenance) out.push({ key: "maintenance", text: `${plural(counts.maintenance, "change")} made by maintenance to look over`, kind: "maintenance" });
  return out;
}
