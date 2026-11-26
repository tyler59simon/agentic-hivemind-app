// What accepting an extracted item writes. Notes go to Living Memory with `capture`; a commitment becomes an action item on
// the project's commitments note (made on first use); a milestone becomes a Hivemind record. Nothing here writes: the review
// dialog runs the plan when the user accepts the item.
import type { CaptureItem, Milestone } from "../../lib/executive";
import { at, type CapturePayload, type NoteRow, type NoteType, type Project } from "../../lib/lm";
import { actionItems, HEADINGS } from "../../lib/note";
import { commitmentsTitle, formatCommitment } from "./commitments";

export type Write =
  | { kind: "note"; domain: string; payload: CapturePayload }
  /** `key` marks a captured item's write, which may be a retry: an open action item with the same text is not added again.
   *  `revision` is the commitments note's revision when the write was planned. */
  | { kind: "action"; ref: string; text: string; revision: string; key?: string }
  | { kind: "milestone"; record: Partial<Milestone> };

export interface Context {
  projects: Project[];
  /** Every tag the store's taxonomy has. */
  known: string[];
  /** Active notes (with tags), to find a project's commitments note. */
  rows: NoteRow[];
  /** Where notes with no project go, and where writing preferences go when the store has a global domain. */
  defaultDomain: string;
  globalDomain?: string;
  sourceLabel: string;
  today: string;
}

const NOTE_TYPE: Partial<Record<CaptureItem["kind"], NoteType>> = {
  decision: "decision", risk: "risk", status: "status", knowledge: "knowledge", preference: "preference",
};

/** The concern tags a type prefers, in order; the first one the taxonomy has is used, else concern/knowledge. */
const CONCERNS: Record<string, string[]> = {
  decision: ["decision"], risk: ["risk", "constraint"], status: ["status"], plan: ["planning", "workflow", "plan"],
  preference: ["preference", "correction"], knowledge: ["knowledge"],
};

export function tagsFor(type: NoteType, project: Project | undefined, known: string[]): string[] {
  const concern = [...(CONCERNS[type] ?? [type]), "knowledge"].map((c) => `concern/${c}`).find((t) => known.includes(t));
  const tags = [concern, project && known.includes(project.tag) ? project.tag : undefined, type === "preference" && known.includes("subject/user") ? "subject/user" : undefined];
  return tags.filter((t): t is string => !!t);
}

export const domainOf = (project: Project | undefined, fallback: string) => project?.charter?.split(":")[0] || fallback;

/** The note body: the summary, the details, and where the item came from. */
export function itemBody(item: CaptureItem, sourceLabel: string, today: string): string {
  const details = [...item.details.map((d) => d.trim()).filter(Boolean), item.owner && `**Owner:** ${item.owner}`, item.due && `**Due:** ${item.due}`]
    .filter(Boolean).map((d) => `- ${d}`);
  const source = `Captured in Hivemind from "${sourceLabel}" on ${today}${item.quote.trim() ? `: "${item.quote.trim()}"` : "."}`;
  return [item.summary.trim(), details.length ? `## ${HEADINGS.details}\n${details.join("\n")}` : "", `## Source\n${source}`].filter(Boolean).join("\n\n");
}

/** The open commitments note of a project (or the cross-project one), if it exists. */
export function commitmentsNote(rows: NoteRow[], project: Project | undefined): NoteRow | undefined {
  const title = commitmentsTitle(project?.name ?? "Cross-project");
  return rows.find((r) => r.type === "plan" && r.status === "active" && r.title === title && (project ? r.tags.includes(project.tag) : !r.tags.some((t) => t.startsWith("project/"))));
}

/** The domain a note for `item` goes to: its project's, the global one for a preference without a project, else the default. */
export function destination(item: CaptureItem, ctx: Context): string {
  const project = ctx.projects.find((p) => p.slug === item.project);
  return item.kind === "preference" && !project && ctx.globalDomain ? ctx.globalDomain : domainOf(project, ctx.defaultDomain);
}

/** Whether accepting `item` may replace the note `ref`: only a note kind, and only a note in the domain it is written to. */
export const replaceable = (item: CaptureItem, ref: string, ctx: Context) =>
  item.kind !== "commitment" && item.kind !== "milestone" && ref.split(":")[0] === destination(item, ctx);

/** Why `item` cannot be accepted as it is, if it cannot. */
export const blocked = (item: CaptureItem) => (!item.title.trim() ? "It needs a title." : item.kind === "milestone" && !item.project ? "A milestone needs a project." : undefined);

/** The key that makes accepting item `item` of batch `batch` safe to repeat: a retry after a crash or a failed batch save
 *  finds what the first try wrote instead of writing it again. None when the ids cannot make a record id. */
export function acceptKey(batch: string, item: string): string | undefined {
  const key = `${batch}-${item}`;
  return /^[A-Za-z0-9-]{1,64}$/.test(key) ? key : undefined;
}

/** Whether a note body already holds the action item `text`, open or ticked. Asked only when an accept repeats its recorded
 *  write: the earlier attempt may have added the item, and the user may have ticked it since. */
export const hasAction = (body: string, text: string) => actionItems(body).some((a) => a.text === text.trim());

/** A note to replace, with the revision the user confirmed it at. */
export interface Replaced { ref: string; revision: string }

/** What accepting `item` writes. `supersedes` is set when the user chose to replace an existing note: it is sent with the
 *  revision the confirmation showed, read for that note on its own (Codex review of e30902f, R2). With `key` (`acceptKey`), a
 *  milestone gets that id and a note that idempotency key, so repeating the write finds the first one. */
export function planWrite(item: CaptureItem, ctx: Context, supersedes?: Replaced, key?: string): Write {
  const project = ctx.projects.find((p) => p.slug === item.project);
  const keyed = key ? { idempotency_key: `hivemind-capture-${key}` } : {};
  if (item.kind === "milestone") {
    const record = { project: item.project ?? "", title: item.title.trim(), due: item.due, status: "planned" as const, note: item.summary.trim() };
    return { kind: "milestone", record: key ? { id: key, ...record } : record };
  }
  if (item.kind === "commitment") {
    const text = formatCommitment({ task: item.title, owner: item.owner, due: item.due });
    const existing = commitmentsNote(ctx.rows, project);
    if (existing) {
      const write = { kind: "action" as const, ref: existing.ref, text, revision: existing.revision };
      return key ? { ...write, key } : write;
    }
    const name = project?.name ?? "Cross-project";
    const body = `Commitments made in meetings and conversations${project ? ` for ${name}` : " that belong to no single project"}. Hivemind adds to this list when you accept a captured commitment.\n\n## ${HEADINGS.actions}\n- [ ] ${text}`;
    return { kind: "note", domain: domainOf(project, ctx.defaultDomain), payload: { title: commitmentsTitle(name), body, type: "plan", tags: tagsFor("plan", project, ctx.known), ...keyed } };
  }
  const type = NOTE_TYPE[item.kind] ?? "knowledge";
  const domain = destination(item, ctx);
  const payload: CapturePayload = { title: item.title.trim(), body: itemBody(item, ctx.sourceLabel, ctx.today), type, tags: tagsFor(type, project, ctx.known), ...keyed };
  return { kind: "note", domain, payload: supersedes ? { ...payload, supersedes: [at(supersedes.ref, supersedes.revision)] } : payload };
}

/** Whether a write names a note without the revision the user confirmed: an action item with none, or a replaced note sent as
 *  a bare ref. An unfinished accept recorded by an older build can hold one; Living Memory would refuse it, so it is planned
 *  and confirmed again instead. */
export const missingRevision = (write: Write): boolean =>
  write.kind === "action" ? !write.revision : write.kind === "note" && (write.payload.supersedes ?? []).some((ref) => !ref.includes("@"));

/** The write accepting `item` runs: the one an unfinished earlier accept recorded (`intent`), or a new plan. `fresh` says the
 *  plan is new and must be recorded on the item before it runs. */
export function acceptWrite(item: CaptureItem, plan: () => Write, replace?: string): { write: Write; superseded?: string; fresh: boolean } {
  const intent = item.intent as { write: Write; superseded?: string } | undefined;
  if (intent) return { write: intent.write, superseded: intent.superseded, fresh: false };
  const write = plan();
  return { write, superseded: write.kind === "note" && write.payload.supersedes ? replace : undefined, fresh: true };
}

/** A capture batch's items still waiting for the user. */
export const pendingItems = (items: CaptureItem[]) => items.filter((i) => i.state === "pending");

export const KIND_LABEL: Record<CaptureItem["kind"], string> = {
  decision: "Decision", risk: "Risk", commitment: "Commitment", status: "Status", milestone: "Milestone", knowledge: "Knowledge", preference: "Preference",
};
