// Project health: what the signals suggest, and the user's own call, which always wins.
import type { Health, HealthStatus, Milestone } from "../../lib/executive";
import { addDays, type CommitmentRow } from "./commitments";

export interface Signals {
  overdueCommitments: number;
  overdueMilestones: number;
  /** Milestones the user marked at risk, or due within 14 days and not done. */
  milestonesAtRisk: number;
  openRisks: number;
  /** Days since the newest status note; null when there is none. */
  statusAge: number | null;
}

export interface Suggestion { status: HealthStatus; reasons: string[] }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Red for an overdue milestone or three or more overdue commitments; amber for any other warning sign; green otherwise. */
export function suggestHealth(s: Signals): Suggestion {
  const red: string[] = [];
  const amber: string[] = [];
  if (s.overdueMilestones) red.push(`${plural(s.overdueMilestones, "milestone")} overdue`);
  if (s.overdueCommitments >= 3) red.push(`${plural(s.overdueCommitments, "commitment")} overdue`);
  else if (s.overdueCommitments) amber.push(`${plural(s.overdueCommitments, "commitment")} overdue`);
  if (s.milestonesAtRisk) amber.push(`${plural(s.milestonesAtRisk, "milestone")} at risk or due within 14 days`);
  if (s.openRisks >= 2) amber.push(`${plural(s.openRisks, "open risk")}`);
  if (s.statusAge === null) amber.push("no status update recorded");
  else if (s.statusAge > 14) amber.push(`last status update ${s.statusAge} days ago`);
  if (red.length) return { status: "red", reasons: [...red, ...amber] };
  if (amber.length) return { status: "amber", reasons: amber };
  return { status: "green", reasons: ["no overdue work, risks or stale status"] };
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from.slice(0, 10)}T12:00:00`)) / 86_400_000);

export function signals(milestones: Milestone[], commitments: CommitmentRow[], openRisks: number, latestStatus: string | undefined, today: string): Signals {
  const open = milestones.filter((m) => m.status !== "done");
  const late = (m: Milestone) => m.status === "missed" || (!!m.due && m.due < today);
  return {
    overdueCommitments: commitments.filter((c) => c.timing === "overdue").length,
    overdueMilestones: open.filter(late).length,
    milestonesAtRisk: open.filter((m) => !late(m) && (m.status === "at_risk" || (!!m.due && m.due <= addDays(today, 14)))).length,
    openRisks,
    statusAge: latestStatus ? daysBetween(latestStatus, today) : null,
  };
}

export interface HealthView { status: HealthStatus; set: boolean; note: string; suggestion: Suggestion; differs: boolean }

/** What to show: the user's call when there is one (with the suggestion when it disagrees), else the suggestion. */
export function healthView(set: Health | undefined, suggestion: Suggestion): HealthView {
  if (!set) return { status: suggestion.status, set: false, note: "", suggestion, differs: false };
  return { status: set.status, set: true, note: set.note, suggestion, differs: set.status !== suggestion.status };
}

export const HEALTH_LABEL: Record<HealthStatus, string> = { green: "On track", amber: "At risk", red: "Off track" };
export const HEALTH_CHIP: Record<HealthStatus, string> = { green: "ok", amber: "warn", red: "bad" };
