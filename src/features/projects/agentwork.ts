// What the agent side of Hivemind needs from the user, and what it did lately, for the Overview. Pure: the page passes in
// what its queries returned.
import type { SessionInfo } from "../../lib/agent";
import type { Drift } from "../../lib/architecture";
import type { LedgerEntry } from "../../lib/skills";
import type { AutomationRun, WorkflowRun } from "../../lib/workflows";

const DAY = 86_400_000;

export type NeedTarget =
  | { page: "review" }
  | { page: "workflows"; tab: "runs" | "automations"; run?: string }
  | { page: "architecture"; system: string };
export interface Need { key: string; text: string; target: NeedTarget }

export interface NeedsInput {
  memoryDrafts: number;
  skillDrafts: number;
  runs: AutomationRun[];
  workflows: WorkflowRun[];
  drift?: Drift | null;
  /** The page already says how many commits the architecture output is behind. */
  behindShown?: boolean;
  stale?: number;
  duplicates?: number;
  now: number;
}

const n = (count: number, word: string, plural = `${word}s`) => `${count} ${count === 1 ? word : plural}`;

/** Each thing waiting for the user, with where it is resolved. */
export function agentNeeds(i: NeedsInput): Need[] {
  const out: Need[] = [];
  const drafts = i.memoryDrafts + i.skillDrafts;
  if (drafts) out.push({ key: "drafts", text: `${n(drafts, "learned draft")} to approve or reject`, target: { page: "review" } });
  const waiting = i.runs.filter((r) => r.state === "waiting").length;
  if (waiting) out.push({ key: "waiting", text: `${n(waiting, "automation run")} waiting for you to start`, target: { page: "workflows", tab: "automations" } });
  const failed = i.runs.filter((r) => r.state === "failed" && i.now - r.at < DAY).length;
  if (failed) out.push({ key: "failed", text: `${n(failed, "automation run")} failed today`, target: { page: "workflows", tab: "automations" } });
  for (const w of i.workflows.filter((w) => w.state === "failed" && w.endedAt != null && i.now - w.endedAt < 3 * DAY)) {
    out.push({ key: `wf-${w.id}`, text: `Workflow failed: ${w.goal.split("\n")[0]}`, target: { page: "workflows", tab: "runs", run: w.id } });
  }
  const d = i.drift;
  // When the page already shows the commits behind, drift is worth a row only for what that does not say.
  const beyondBehind = (x: Drift) => (x.edited?.length ?? 0) > 0 || !!x.findings?.some((f) => f.severity === "error" && !f.existing) || (x.layout?.findings ?? 0) > 0;
  if (d?.attention && (!i.behindShown || beyondBehind(d))) out.push({ key: "drift", text: `Architecture drift: ${d.summary}`, target: { page: "architecture", system: d.system } });
  const tidy = [i.stale ? n(i.stale, "stale note") : "", i.duplicates ? n(i.duplicates, "possible duplicate") : ""].filter(Boolean);
  if (tidy.length) out.push({ key: "tidy", text: `${tidy.join(" and ")} in memory`, target: { page: "review" } });
  return out;
}

export type ActivityTarget = { session: string } | { workflow: string } | { automations: true } | { skill: string };
export interface Activity { key: string; at: number; text: string; target: ActivityTarget }

/** What agents, workflows, automations and the skills library did, newest first. */
export function agentActivity(i: { sessions: SessionInfo[]; workflows: WorkflowRun[]; runs: AutomationRun[]; ledger: LedgerEntry[]; automationName: (id: string) => string }, limit = 12): Activity[] {
  const out: Activity[] = [];
  for (const s of i.sessions) {
    if (s.endedAt == null) continue;
    const how = s.status === "failed" ? "failed" : s.status === "cancelled" ? "was stopped" : "finished";
    out.push({ key: `s-${s.id}`, at: s.endedAt, text: `Session ${how}: ${s.name ?? s.title}`, target: { session: s.id } });
  }
  for (const w of i.workflows) {
    if (w.state === "planned") continue;
    const at = w.endedAt ?? w.createdAt;
    const how = w.state === "running" ? "started" : w.state === "succeeded" ? "finished" : w.state === "failed" ? "failed" : "was cancelled";
    out.push({ key: `w-${w.id}`, at, text: `Workflow ${how}: ${w.goal.split("\n")[0]}`, target: { workflow: w.id } });
  }
  for (const r of i.runs) {
    const how = r.state === "waiting" ? "is waiting" : r.state === "running" ? "is running" : r.state === "succeeded" ? "ran" : r.state === "failed" ? "failed" : "was cancelled";
    out.push({ key: `a-${r.id}`, at: r.at, text: `${i.automationName(r.automation)} ${how}${r.detail && r.state !== "running" ? `: ${r.detail.split("\n")[0]}` : ""}`, target: { automations: true } });
  }
  for (const e of i.ledger) {
    out.push({ key: `k-${e.at}-${e.name}-${e.action}`, at: e.at, text: `Skill ${e.name}: ${e.action}${e.version ? ` (version ${e.version})` : ""}`, target: { skill: e.name } });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
