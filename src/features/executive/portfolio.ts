// The portfolio: one row per project, built from one `list` and one `open` call over every domain, plus Hivemind's
// milestones and health records. A note belongs to every project its `project/<slug>` tags name.
import type { Health, Milestone } from "../../lib/executive";
import type { NoteRow, OpenItem, Project } from "../../lib/lm";
import { commitmentRows, type CommitmentRow } from "./commitments";
import { healthView, signals, suggestHealth, type HealthView } from "./health";

export interface ProjectRow {
  project: Project;
  health: HealthView;
  commitments: CommitmentRow[];
  milestones: Milestone[];
  /** The first milestone not done, by due date (undated last). */
  next: Milestone | undefined;
  risks: NoteRow[];
  decisions: NoteRow[];
  latestStatus: NoteRow | undefined;
  /** The newest note update, YYYY-MM-DD. */
  lastActivity: string | undefined;
}

const newestFirst = (a: NoteRow, b: NoteRow) => b.updated.localeCompare(a.updated);
const byDue = (a: Milestone, b: Milestone) => (a.due || "9999").localeCompare(b.due || "9999");

/** The open items whose note carries `tag` (an item is anything with the note's `ref`, such as Home's action items). */
export function itemsTagged<T extends { ref?: string }>(items: T[], rows: NoteRow[], tag: string): T[] {
  const refs = new Set(rows.filter((r) => r.tags.includes(tag)).map((r) => r.ref));
  return items.filter((i) => i.ref !== undefined && refs.has(i.ref));
}

export function projectRow(project: Project, rows: NoteRow[], items: OpenItem[], milestones: Milestone[], health: Health[], today: string): ProjectRow {
  const mine = rows.filter((r) => r.status === "active" && r.tags.includes(project.tag)).sort(newestFirst);
  const commitments = commitmentRows(itemsTagged(items, rows, project.tag), today);
  const ms = milestones.filter((m) => m.project === project.slug).sort(byDue);
  const risks = mine.filter((r) => r.type === "risk" || r.type === "bug");
  const latestStatus = mine.find((r) => r.type === "status");
  const suggestion = suggestHealth(signals(ms, commitments, risks.length, latestStatus?.updated, today));
  return {
    project,
    health: healthView(health.find((h) => h.project === project.slug), suggestion),
    commitments,
    milestones: ms,
    next: ms.find((m) => m.status !== "done"),
    risks,
    decisions: mine.filter((r) => r.type === "decision"),
    latestStatus,
    lastActivity: mine[0]?.updated.slice(0, 10),
  };
}

const RANK = { red: 0, amber: 1, green: 2 } as const;

/** Every project that is not archived, worst health first, then by name. */
export function portfolio(projects: Project[], rows: NoteRow[], items: OpenItem[], milestones: Milestone[], health: Health[], today: string): ProjectRow[] {
  return projects
    .filter((p) => p.status !== "archived")
    .map((p) => projectRow(p, rows, items, milestones, health, today))
    .sort((a, b) => RANK[a.health.status] - RANK[b.health.status] || a.project.name.localeCompare(b.project.name));
}

/** The notes that belong to no project and hold commitments (the cross-project commitments note, mostly). */
export const looseRefs = (rows: NoteRow[]) =>
  new Set(rows.filter((r) => r.status === "active" && r.title.startsWith("Commitments:") && !r.tags.some((t) => t.startsWith("project/"))).map((r) => r.ref));

/** Commitments on notes that belong to no project (the cross-project commitments note, mostly). */
export function crossProject(items: OpenItem[], rows: NoteRow[], today: string): CommitmentRow[] {
  const loose = looseRefs(rows);
  return commitmentRows(items.filter((i) => loose.has(i.ref)), today);
}

/** What needs the leader's attention across the portfolio. */
export interface Attention {
  overdue: (CommitmentRow & { project: Project })[];
  dueSoon: (CommitmentRow & { project: Project })[];
  milestones: (Milestone & { projectName: string })[];
  atRisk: ProjectRow[];
}

export function attention(rows: ProjectRow[], today: string): Attention {
  const all = rows.flatMap((r) => r.commitments.map((c) => ({ ...c, project: r.project })));
  const horizon = new Date(`${today}T12:00:00`);
  horizon.setDate(horizon.getDate() + 14);
  const until = horizon.toISOString().slice(0, 10);
  return {
    overdue: all.filter((c) => c.timing === "overdue"),
    dueSoon: all.filter((c) => c.timing === "soon"),
    milestones: rows.flatMap((r) => r.milestones.filter((m) => m.status !== "done" && m.due && m.due <= until).map((m) => ({ ...m, projectName: r.project.name }))).sort(byDue),
    // A paused project counts only when the user set its health: its quiet signals are expected.
    atRisk: rows.filter((r) => r.health.status !== "green" && (r.project.status !== "paused" || r.health.set)),
  };
}
