// The spending limits the Settings form edits. Rust (settings.rs) holds the defaults and checks every value; these mirror
// the defaults for the placeholders.

/** The executive workspace's calls with their default limits in US dollars (settings.rs EXECUTIVE_CALLS), as Settings lists them. */
export const EXECUTIVE_CALLS = [
  { id: "brief", label: "Briefing", usd: 0.5 },
  { id: "extract", label: "Capture from notes", usd: 0.25 },
] as const;

export const BUDGET_DEFAULTS = { agentRun: 5, automationsDaily: 5, learningDaily: 1, review: 0.25 } as const;

/** A number input's value: a number, or null when it is empty so the default applies. */
export function amount(text: string): number | null {
  const usd = Number(text);
  return text.trim() === "" || !Number.isFinite(usd) ? null : usd;
}

/** The per-call limits with one call set, or left out when empty so it uses its default. Null when none is set. */
export function withCallLimit(all: Record<string, number> | null | undefined, call: string, usd: number | null): Record<string, number> | null {
  const next = { ...(all ?? {}) };
  if (usd === null) delete next[call]; else next[call] = usd;
  return Object.keys(next).length ? next : null;
}
