// Pure helpers for the project dashboard: group member notes into sections, plan progress, the project's slice of the link graph and journal.
import type { LinkGraph, NoteRow, OpenItem, Operation, Project } from "../../lib/lm";
import { noteIdsOf } from "../history/activity";

export interface DashboardSections {
  charter?: NoteRow;
  latestStatus?: NoteRow;
  roadmap: NoteRow[];
  decisions: NoteRow[];
  risks: NoteRow[];
  knowledge: NoteRow[];
  retired: NoteRow[];
}

const KNOWLEDGE = new Set<NoteRow["type"]>(["knowledge", "research", "context", "map", "policy", "preference"]);
const newest = (key: "created" | "updated") => (a: NoteRow, b: NoteRow) => b[key].localeCompare(a[key]);

export function dashboardSections(rows: NoteRow[], charterRef: string | null): DashboardSections {
  const active = (r: NoteRow) => r.status === "active";
  const charter = charterRef ? rows.find((r) => r.ref === charterRef) : undefined;
  const live = rows.filter((r) => r !== charter);
  const of = (type: NoteRow["type"]) => live.filter((r) => r.type === type);
  const risky = [...of("risk"), ...of("bug")];
  return {
    charter,
    latestStatus: of("status").filter(active).sort(newest("updated"))[0],
    roadmap: of("plan").filter(active).sort(newest("updated")),
    decisions: of("decision").filter(active).sort(newest("created")),
    risks: [
      ...risky.filter(active).sort(newest("updated")),
      ...risky.filter((r) => r.status === "resolved").sort(newest("updated")),
    ],
    knowledge: live.filter((r) => active(r) && KNOWLEDGE.has(r.type)).sort(newest("updated")),
    retired: live.filter((r) => r.status === "archived" || r.status === "superseded").sort(newest("updated")),
  };
}

export function progress(row: Pick<NoteRow, "actions">): { done: number; total: number; pct: number } {
  const done = row.actions?.done ?? 0;
  const total = done + (row.actions?.open ?? 0);
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** The member notes plus their one-hop neighbours, and only the edges among them. */
export function projectGraph(graph: LinkGraph, refs: Set<string>): LinkGraph {
  const keep = new Set(refs);
  for (const e of graph.edges) {
    if (refs.has(e.from)) keep.add(e.to);
    if (refs.has(e.to)) keep.add(e.from);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.ref)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    unresolved: graph.unresolved.filter((u) => refs.has(u.from)),
  };
}

/** Operations touching a member note (matched on the 8-character ID prefix in LM file names) or the registry file. */
export function projectOps(ops: Operation[], memberIds: Set<string>): Operation[] {
  const prefixes = new Set([...memberIds].map((id) => id.slice(0, 8).toLowerCase()));
  return ops.filter((op) =>
    noteIdsOf(op).some((id) => prefixes.has(id.toLowerCase())) || op.files.some((f) => f.split("/").pop() === "projects.json"));
}

/** Open action items per project slug, joining each item's note to its project tags. */
export function openCountsByProject(items: OpenItem[], rows: NoteRow[], projects: Project[]): Map<string, number> {
  const tagsOf = new Map(rows.map((r) => [r.ref, r.tags]));
  const counts = new Map(projects.map((p) => [p.slug, 0]));
  const bySlug = new Map(projects.map((p) => [p.tag, p.slug]));
  for (const item of items) {
    for (const tag of tagsOf.get(item.ref) ?? []) {
      const slug = bySlug.get(tag);
      if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return counts;
}
