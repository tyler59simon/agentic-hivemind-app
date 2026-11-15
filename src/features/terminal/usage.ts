import type { Engine } from "../../lib/agent";

/** One plan window of Codex's rate limits. */
export interface LimitWindow { usedPercent: number; windowMinutes: number; resetsAt: number }

/** `agent_usage`: what a terminal session has used, read from its CLI's own file. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number | null;
  costExact: boolean;
  limits: { primary: LimitWindow | null; secondary: LimitWindow | null } | null;
}

/** How often usage is read again while the session runs. */
export const USAGE_POLL_MS = 5000;

/** The `refetchInterval` of the usage query: once for a session that is over. */
export const usagePollMs = (running: boolean): number | false => (running ? USAGE_POLL_MS : false);

/** "950", "12.4k", "1.2M". */
export function formatTokens(n: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 999_950) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

const money = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** The plan window with the higher share used, named: 300 minutes is the "5-hour limit", 10080 the "weekly limit". */
export function fullestWindow(usage: Pick<Usage, "limits">): { name: string; usedPercent: number } | null {
  const windows = [usage.limits?.primary, usage.limits?.secondary].filter((w): w is LimitWindow => !!w);
  if (!windows.length) return null;
  const top = windows.reduce((best, w) => (w.usedPercent > best.usedPercent ? w : best));
  const name = top.windowMinutes === 10080 ? "weekly limit" : `${Math.round(top.windowMinutes / 60)}-hour limit`;
  return { name, usedPercent: top.usedPercent };
}

/** "12.4k tokens · $0.31", "12.4k tokens · ≈ $0.31" (an estimate), Codex "41.9k tokens · 28% of weekly limit"; "" before any use. */
export function usageText(usage: Usage | undefined): string {
  if (!usage) return "";
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (usage.costUsd !== null) parts.push(`${usage.costExact ? "" : "≈ "}${money(usage.costUsd)}`);
  const window = fullestWindow(usage);
  if (window) parts.push(`${Math.round(window.usedPercent)}% of ${window.name}`);
  return parts.join(" · ");
}

export type BudgetLevel = "none" | "warn" | "over";

/** Warn from 80% and over from 100% of the budget (Claude, by cost) or of the fuller plan window (Codex). Nothing is ever stopped. */
export function budgetLevel(engine: Engine, usage: Usage | undefined, budgetUsd: number): BudgetLevel {
  const share = engine === "codex"
    ? (usage && fullestWindow(usage)?.usedPercent) || 0
    : usage?.costUsd != null && budgetUsd > 0 ? (usage.costUsd / budgetUsd) * 100 : 0;
  return share >= 100 ? "over" : share >= 80 ? "warn" : "none";
}

/** The banner's words for a level other than "none". */
export function budgetMessage(engine: Engine, usage: Usage, budgetUsd: number, level: Exclude<BudgetLevel, "none">): string {
  if (engine === "codex") {
    const window = fullestWindow(usage);
    const name = window?.name ?? "plan limit";
    return level === "over" ? `Codex has reached your ${name}.` : `Codex has used ${Math.round(window?.usedPercent ?? 0)}% of your ${name}.`;
  }
  const budget = `$${budgetUsd.toFixed(2)}`;
  return level === "over"
    ? `This session is over your ${budget} budget. Hivemind does not stop it.`
    : `This session has used ${money(usage.costUsd ?? 0)} of your ${budget} budget.`;
}
