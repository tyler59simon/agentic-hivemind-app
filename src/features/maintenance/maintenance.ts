// Pure helpers for the Maintenance page, which draws Living Memory's `maintenance` commands.
import type { MaintenanceDecision, MaintenanceRun, MaintenanceStatus } from "../../lib/lm";

/** Plain words for the status's `skip_reason`: why no run is due right now. */
export function skipReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case null: case undefined: case "": return "";
    case "disabled": return "Maintenance is off.";
    case "interval": return "A run happened recently; the next one waits for the minimum interval.";
    case "daily_note_limit": return "Today's note limit is reached.";
    case "daily_budget": return "Today's budget is used up.";
    case "provider_budget": return "The model provider refused for budget; change the budget to clear it.";
    case "policy_unknown": return "The maintenance policy version is not one this store knows.";
    case "accounting_unavailable": return "The maintenance accounting files could not be read.";
    default: return reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + ".";
  }
}

/** One line on when the next run can start. */
export function nextRunText(s: Pick<MaintenanceStatus, "enabled" | "running" | "eligible" | "next_eligible_at" | "skip_reason" | "blocked">, now = new Date()): string {
  if (!s.enabled) return "Off. No notes are reviewed.";
  if (s.running) return "A run is in progress.";
  if (s.blocked) return `Blocked: ${s.blocked.reason.replace(/_/g, " ")}.`;
  if (s.eligible) return "A run is due. It starts with the next agent session.";
  const reason = skipReasonText(s.skip_reason);
  const when = s.next_eligible_at ? new Date(s.next_eligible_at) : null;
  if (when && !Number.isNaN(when.getTime()) && when > now) return `Next run after ${when.toLocaleString()}. ${reason}`.trim();
  return reason || "Waiting.";
}

/** "$0.073" from LM's decimal string; blank when it is not a number. */
export function usd(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(n >= 1 ? 2 : 3)}` : "";
}

/** Cost with a caveat when some of the run's spend could not be measured. */
export const costText = (charged: string, complete: boolean) => `${usd(charged) || "$0"}${complete ? "" : " (incomplete)"}`;

/** The non-zero counts of a run, in the order the history lists them; "reviewed" always shows. */
export function runCounts(r: MaintenanceRun): { label: string; n: number }[] {
  const all: [string, number][] = [
    ["reviewed", r.reviewed], ["kept", r.kept], ["deferred", r.deferred], ["archived", r.archived], ["updated", r.updated],
    ["confirmed", r.confirmed], ["resolved", r.resolved], ["superseded", r.superseded],
  ];
  return all.filter(([label, n]) => n > 0 || label === "reviewed").map(([label, n]) => ({ label, n }));
}

/** "10 reviewed, 1 kept, 9 deferred" */
export const runSummary = (r: MaintenanceRun) => runCounts(r).map((c) => `${c.n} ${c.label}`).join(", ");

// LM records a decision's outcome in `result` (applied, already_applied, kept, deferred, skipped, rejected); what was done is the `action`.
const APPLIED: Record<string, string> = {
  archive: "Archived", update: "Updated", confirm: "Confirmed still true", resolve: "Resolved", supersede: "Superseded", distinct: "Marked distinct",
};
const RESULTS: Record<string, string> = { kept: "Kept", deferred: "Deferred for later", skipped: "Skipped", rejected: "Refused by policy" };
const applied = (d: Pick<MaintenanceDecision, "result">) => d.result === "applied" || d.result === "already_applied";
/** A decision's result in words. */
export const resultText = (d: Pick<MaintenanceDecision, "result" | "action">) =>
  applied(d) ? APPLIED[d.action] ?? d.action.replace(/_/g, " ") : RESULTS[d.result] ?? d.result.replace(/_/g, " ");

/** Whether the run archived this note (a candidate for Restore). */
export const wasArchived = (d: Pick<MaintenanceDecision, "result" | "action">) => applied(d) && d.action === "archive";

/** The decisions to show: those the run acted on first, then kept, deferred and skipped ones, each in LM's order. */
export function sortDecisions(ds: MaintenanceDecision[]): MaintenanceDecision[] {
  const weight = (d: MaintenanceDecision) => (applied(d) ? 0 : 1);
  return ds.map((d, i) => ({ d, i })).sort((a, b) => weight(a.d) - weight(b.d) || a.i - b.i).map((x) => x.d);
}

// ---- The Inbox: what maintenance deferred, and what it did that the user may want to undo. ----

/** Runs listed on the Maintenance page and read for the Inbox. */
export const HISTORY_LIMIT = 30;
/** A due note shows in the Inbox when the latest decision about it in this many days was a defer. */
export const DEFER_DAYS = 30;
/** An applied decision shows in the Inbox for this many days. */
export const APPLIED_DAYS = 7;
const DAY = 86_400_000;

/** A run with the decisions it recorded. */
export interface RunDecisions { run: MaintenanceRun; decisions: MaintenanceDecision[] }
const startedAt = (r: Pick<MaintenanceRun, "attempted_at">) => Date.parse(r.attempted_at);

/** The runs to read decisions from: ones that reviewed notes, started within `days` days of `now`. */
export const runsWithin = (runs: MaintenanceRun[], now: number, days: number): MaintenanceRun[] =>
  runs.filter((r) => r.reviewed > 0 && now - startedAt(r) <= days * DAY);

/** A decision's rule and reason, or its reason code in words. */
export function reasonText(d: Pick<MaintenanceDecision, "rule" | "reason" | "reason_code">): string {
  const text = [d.rule, d.reason].filter(Boolean).join(": ");
  return text || (d.reason_code ? d.reason_code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");
}

/** The notes whose latest decision in the last `DEFER_DAYS` days was a defer or a refusal by policy (maintenance could not
 *  decide), with that decision. A later run that kept or changed a note takes it off the list. */
export function deferredNotes(done: RunDecisions[], now: number): Map<string, MaintenanceDecision> {
  const latest = new Map<string, { at: number; decision: MaintenanceDecision }>();
  for (const { run, decisions } of done) {
    const at = startedAt(run);
    if (Number.isNaN(at) || now - at > DEFER_DAYS * DAY) continue;
    for (const decision of decisions) {
      const seen = latest.get(decision.ref);
      if (!seen || at >= seen.at) latest.set(decision.ref, { at, decision });
    }
  }
  return new Map([...latest].filter(([, v]) => v.decision.result === "deferred" || v.decision.result === "rejected").map(([ref, v]) => [ref, v.decision]));
}

/** An applied decision the Inbox lists: undoable through `operation_id`, which is also its key. */
export interface AppliedItem { key: string; ref: string; decision: MaintenanceDecision; run: MaintenanceRun; at: number }
const UNDOABLE = new Set(["archive", "resolve", "supersede", "update"]);

/** The decisions of the last `APPLIED_DAYS` days that archived, resolved, superseded or updated a note, newest first, without
 *  the ones the user marked "Looks right". `seen` maps an operation id to the time of the run it came from. */
export function appliedDecisions(done: RunDecisions[], now: number, seen: Record<string, number>): AppliedItem[] {
  const out: AppliedItem[] = [];
  for (const { run, decisions } of done) {
    const at = startedAt(run);
    if (Number.isNaN(at) || now - at > APPLIED_DAYS * DAY) continue;
    for (const decision of decisions) {
      const id = decision.operation_id;
      if (decision.result === "applied" && UNDOABLE.has(decision.action) && id && !(id in seen)) out.push({ key: id, ref: decision.ref, decision, run, at });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The ids still worth keeping: those of runs from the last `APPLIED_DAYS` days. */
export function pruneSeen(seen: Record<string, number> | undefined, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(seen ?? {}).filter(([, at]) => Number.isFinite(at) && now - at <= APPLIED_DAYS * DAY));
}
