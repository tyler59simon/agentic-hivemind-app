// Pure helpers for changes: the view model, the status chip, the Start screen's gate and the checkpoint note.
import type { SessionInfo } from "../../lib/agent";
import { STAGES, type Change, type ChangeStage, type LinkGraph, type LinkNode, type NoteRow, type System } from "../../lib/lm";
import { HEADINGS } from "../../lib/note";
import { isEnded, waitingForReview } from "../agents/session";
import type { NoteLinks } from "../links/useLinks";

export type StepState = "done" | "current" | "later";
export interface Chip { label: string; tone: "" | "active" | "waiting" | "busy" }
/** What the app may do with a change's brief: "ok" (active or resolved), "retired" (archived or superseded), "missing" (no note). */
export type BriefState = "ok" | "retired" | "missing";
/** Whether the Start screen may start a session for the change in the draft. */
export type LinkState =
  | { kind: "none" }
  | { kind: "loading"; what: string }
  | { kind: "failed"; message: string }
  | { kind: "ready" };

/** Everything the screens show about one change, joined from the registry, sessions, links and notes. */
export interface ChangeView {
  change: Change;
  /** Sessions whose task carries this change, newest first. */
  sessions: SessionInfo[];
  latest: SessionInfo | undefined;
  chip: Chip;
  /** The later of the entry's `updated` and the brief's. */
  updated: string;
  decisions: LinkNode[];
  questions: LinkNode[];
  checkpoints: LinkNode[];
  hasDiagram: boolean;
}
export interface ViewContext {
  sessions: SessionInfo[]; graph: LinkGraph | undefined;
  due: Set<string>;
  rows: Map<string, NoteRow>;
  systems: System[];
}

export const displayId = (id: number) => `CHG-${String(id).padStart(3, "0")}`;
export const STAGE_LABELS: Record<ChangeStage, string> = { explore: "Explore", design: "Design", implement: "Implement", validate: "Validate" };

/** One state per stage, in STAGES order: every stage is done for a done change. */
export function stageStates(change: Pick<Change, "stage" | "status">): StepState[] {
  const at = STAGES.indexOf(change.stage);
  return STAGES.map((_, i) => (change.status === "done" || i < at ? "done" : i === at ? "current" : "later"));
}

export function briefState(change: Pick<Change, "brief_status">): BriefState {
  const s = change.brief_status;
  return s === null ? "missing" : s === "archived" || s === "superseded" ? "retired" : "ok";
}

/** The stage a click moves to, or null at the last stage, for a change that is not active, and for one whose brief is not "ok". */
export function nextStage(change: Pick<Change, "stage" | "status" | "brief_status">): ChangeStage | null {
  if (change.status !== "active" || briefState(change) !== "ok") return null;
  return STAGES[STAGES.indexOf(change.stage) + 1] ?? null;
}

export function linkState(p: {
  change: number | null; changesOn: boolean;
  registryLoading: boolean; registryError: string | null; linked: Change | undefined;
  branchesLoading: boolean; branchesError: string | null; applied: boolean;
  briefLoading: boolean; briefError: string | null;
}): LinkState {
  if (p.change === null) return { kind: "none" };
  const D = displayId(p.change);
  const failed = (message: string): LinkState => ({ kind: "failed", message });
  const loading = (what: string): LinkState => ({ kind: "loading", what });
  if (!p.changesOn) return failed(`${D} cannot be loaded: this Living Memory has no changes command.`);
  if (p.registryLoading) return loading(`Loading ${D}…`);
  if (p.registryError) return failed(`${D} could not be loaded: ${p.registryError}`);
  if (!p.linked) return failed(`${D} is not in the change registry.`);
  if (briefState(p.linked) === "missing") return failed(`The brief of ${D} is missing, so its briefing cannot be built.`);
  if (p.briefLoading) return loading(`Loading the brief of ${D}…`);
  if (p.briefError) return failed(`The brief of ${D} could not be loaded: ${p.briefError}`);
  if (p.branchesError) return failed(`The branches for ${D} could not be read: ${p.branchesError}`);
  if (p.branchesLoading || !p.applied) return loading(`Loading the repository and branch of ${D}…`);
  return { kind: "ready" };
}

/** A session's engine as the mocks name it. The Claude Code adapter stores "claude-code"; Phase 5 adds Codex. */
export const engineName = (adapter: string) => ({ "claude-code": "Claude Code", codex: "Codex" } as Record<string, string>)[adapter] ?? adapter;

/** Sessions whose task carries this change, newest first. */
export const sessionsOf = (id: number, sessions: SessionInfo[]): SessionInfo[] =>
  sessions.filter((s) => s.task.kind === "work" && s.task.change === id).sort((a, b) => b.startedAt - a.startedAt);

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function changeChip(change: Change, sessions: SessionInfo[], due: boolean): Chip {
  if (change.status === "done") return { label: "Done", tone: "active" };
  if (change.status === "cancelled") return { label: "Cancelled", tone: "" };
  if (sessions.some(waitingForReview)) return { label: "Waiting for review", tone: "waiting" };
  if (due) return { label: "Needs review", tone: "" };
  if (sessions.some((s) => !isEnded(s)) || change.actions.done > 0 || change.stage !== "explore") return { label: "In progress", tone: "busy" };
  return { label: "Not started", tone: "" };
}

/** Notes linked to or from this note with a [[link]], each once. */
export function connected(graph: LinkGraph | undefined, ref: string): LinkNode[] {
  if (!graph) return [];
  const nodes = new Map(graph.nodes.map((n) => [n.ref, n]));
  const seen = new Set<string>(), out: LinkNode[] = [];
  for (const e of graph.edges) {
    if (e.kind !== "link" || (e.from !== ref && e.to !== ref)) continue;
    const other = nodes.get(e.from === ref ? e.to : e.from);
    if (other && !seen.has(other.ref)) { seen.add(other.ref); out.push(other); }
  }
  return out;
}

/** The notes linked to or from a change's brief that the screens and the session briefing use. */
export function linkedContext(graph: LinkGraph | undefined, change: Pick<Change, "brief" | "display">): Pick<ChangeView, "decisions" | "questions" | "checkpoints"> {
  const linked = connected(graph, change.brief);
  return {
    decisions: linked.filter((n) => n.type === "decision"),
    questions: linked.filter((n) => n.type === "risk" && n.status === "active"),
    // Only the app's own checkpoint notes: other status notes may link to the brief too, and titles are all there is to sort by.
    checkpoints: linked.filter((n) => n.type === "status" && n.title.startsWith(`${change.display} checkpoint `)).sort((a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0)),
  };
}

export function viewOf(change: Change, ctx: ViewContext): ChangeView {
  const sessions = sessionsOf(change.id, ctx.sessions);
  const brief = ctx.rows.get(change.brief)?.updated ?? "";
  const system = change.system ? ctx.systems.find((s) => s.slug === change.system) : undefined;
  return {
    change, sessions, latest: sessions[0],
    chip: changeChip(change, sessions, ctx.due.has(change.brief)),
    updated: brief > change.updated ? brief : change.updated,
    ...linkedContext(ctx.graph, change),
    hasDiagram: !!system?.architecture,
  };
}

/** The card's meta lines. `first` is empty without a session. */
export function metaLines(view: ChangeView, updatedLabel: string): { first: string[]; second: string[] } {
  const { latest, change } = view;
  const first: string[] = [];
  if (latest) {
    first.push(engineName(latest.adapter));
    const n = latest.filesChanged?.files ?? 0;
    if (n > 0) first.push(`${plural(n, "file")} ${waitingForReview(latest) ? "proposed" : "changed"}`);
  }
  const second: string[] = [];
  const brief = briefState(change);
  if (brief === "missing") second.push("Brief missing");
  else if (brief === "retired") second.push(`Brief ${change.brief_status}`);
  if (!latest) second.push(STAGE_LABELS[change.stage]);
  if (view.decisions.length > 0) second.push(plural(view.decisions.length, "decision"));
  if (view.hasDiagram) second.push("1 diagram");
  second.push("Updated " + updatedLabel);
  return { first, second };
}

/** What the linked-session block says under the session title. */
export function sessionLine(s: SessionInfo): string {
  if (waitingForReview(s)) return `${plural(s.filesChanged?.files ?? 0, "file")} awaiting review`;
  switch (s.status) {
    case "running": return "Working…";
    case "waiting": return "Waiting for you";
    case "idle": return `Ready · ${plural(s.turns, "turn")}`;
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return "Ended";
  }
}

/** The change the Overview features: an active one waiting for review first, else the most recently updated active one. */
export function topChange(views: ChangeView[]): ChangeView | undefined {
  const active = views.filter((v) => v.change.status === "active");
  return active.find((v) => v.chip.label === "Waiting for review") ?? active.reduce<ChangeView | undefined>((best, v) => (!best || v.updated > best.updated ? v : best), undefined);
}

/** Changes whose brief is this note, or which this note links to or from. */
export function changesFor(ref: string, links: NoteLinks, changes: Change[]): Change[] {
  const refs = new Set([ref]);
  for (const l of [...links.incoming, ...links.outgoing]) if (l.kind === "link") refs.add(l.node.ref);
  return changes.filter((c) => refs.has(c.brief));
}

/** Active plan notes that are no change's brief (and not the charter), newest first. */
export function unadopted(rows: NoteRow[], changes: Change[], charter: string | null): NoteRow[] {
  const briefs = new Set(changes.map((c) => c.brief));
  return rows.filter((r) => r.type === "plan" && r.status === "active" && r.ref !== charter && !briefs.has(r.ref))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

/** Note refs a session for this change starts with: the brief, then its decisions and open questions. */
export function contextRefs(view: ChangeView): string[] {
  const refs = [...(briefState(view.change) === "missing" ? [] : [view.change.brief]), ...view.decisions.map((n) => n.ref), ...view.questions.map((n) => n.ref)];
  return [...new Set(refs)];
}

export function checkpointTitle(display: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${display} checkpoint ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export function checkpointBody(p: { summary: string; briefTitle: string; stage: ChangeStage; branch: string | null;
  steps: { done: number; total: number }; evidence: { done: number; total: number } }): string {
  const details = [
    `* **Stage:** ${STAGE_LABELS[p.stage]}`,
    ...(p.steps.total > 0 ? [`* **Steps:** ${p.steps.done} of ${p.steps.total} done`] : []),
    ...(p.evidence.total > 0 ? [`* **Evidence:** ${p.evidence.done} of ${p.evidence.total} verified`] : []),
    ...(p.branch !== null ? [`* **Branch:** ${p.branch}`] : []),
  ];
  return `## ${HEADINGS.summary}\n${p.summary}\n\n---\n\n## ${HEADINGS.details}\n${details.join("\n")}\n\n## ${HEADINGS.links}\n* [[${p.briefTitle}]]`;
}
