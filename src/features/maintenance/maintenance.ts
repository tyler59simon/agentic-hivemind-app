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
