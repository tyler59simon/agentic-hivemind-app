// Pure helpers for the Skills page and the Learned review group: words for states, reliability, and ledger rows.
import type { CopyState, LedgerEntry, ReviewRun, Skill, SkillProposal } from "../../lib/skills";

/** "4 of 5 approved (80%)", or why there is no figure yet. A correlation from review outcomes, not proof. */
export function reliabilityText(s: Pick<Skill, "approved" | "rejected" | "reliability">): string {
  if (s.reliability == null) return "No judged sessions yet";
  return `${s.approved} of ${s.approved + s.rejected} approved (${Math.round(s.reliability * 100)}%)`;
}

/** The one state the list shows for a skill, most urgent first. */
export function skillState(s: Pick<Skill, "archived" | "flagged" | "stale" | "copies">): { label: string; tone: "" | "active" | "waiting" | "failed" } {
  if (s.archived) return { label: "archived", tone: "" };
  if (s.copies.some((c) => c.state === "edited")) return { label: "edited outside Hivemind", tone: "waiting" };
  if (s.flagged) return { label: "flagged", tone: "failed" };
  if (s.stale) return { label: "stale", tone: "waiting" };
  if (!s.copies.length) return { label: "not published", tone: "waiting" };
  return { label: "published", tone: "active" };
}

export const COPY_WORDS: Record<CopyState, string> = {
  current: "Current version", older: "An older version", edited: "Edited outside Hivemind", missing: "SKILL.md is missing",
};

/** "Claude Code" or "Codex" for a published folder; the path otherwise. */
export function copyPlace(dir: string): string {
  const norm = dir.replace(/\\/g, "/");
  if (norm.includes("/.claude/skills/")) return "Claude Code";
  if (norm.includes("/.codex/skills/")) return "Codex";
  return dir;
}

const ACTIONS: Record<string, string> = {
  propose_create: "proposed", propose_patch: "proposed a change", propose_archive: "proposed archiving", approve_create: "approved",
  approve_patch: "approved a change", reject: "rejected a proposal", publish: "published", archive: "archived", import: "imported an outside edit",
};
const ACTORS: Record<string, string> = { user: "You", reviewer: "The reviewer", upkeep: "Upkeep", auto: "Hivemind (auto-patch)" };

/** "You approved a change (v3)" */
export function ledgerText(e: Pick<LedgerEntry, "actor" | "action" | "version">): string {
  const restore = /^restore_v(\d+)$/.exec(e.action);
  const what = restore ? `restored version ${restore[1]}` : ACTIONS[e.action] ?? e.action.replace(/_/g, " ");
  return `${ACTORS[e.actor] ?? e.actor} ${what}${e.version ? ` (v${e.version})` : ""}`;
}

export function proposalTitle(p: Pick<SkillProposal, "kind" | "name">): string {
  return p.kind === "create" ? `New skill: ${p.name}` : p.kind === "patch" ? `Change to ${p.name}` : `Archive ${p.name}`;
}

/** What a review run produced, in one line. */
export function runText(r: Pick<ReviewRun, "state" | "memory" | "skillName" | "skillApplied" | "error">): string {
  if (r.state === "failed") return r.error ?? "Failed";
  if (r.state === "nothing") return "Nothing worth keeping";
  const parts = [];
  if (r.memory.length) parts.push(`${r.memory.length} note${r.memory.length === 1 ? "" : "s"} proposed`);
  if (r.skillName) parts.push(r.skillApplied ? `${r.skillName} updated` : `skill ${r.skillName} proposed`);
  return parts.join(", ") + (r.error ? ` (${r.error})` : "");
}

/** A SKILL.md's description and body, as Rust's parse reads them. */
export function parse(text: string): { description: string; body: string } {
  const t = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { description: "", body: t.trim() };
  const raw = /^description:(.*)$/m.exec(m[1])?.[1].trim() ?? "";
  let description = raw;
  try { description = JSON.parse(raw); } catch { description = raw.replace(/^["']|["']$/g, ""); }
  return { description, body: m[2].trim() };
}

/** The latest review of a session, if any. */
export const lastRun = (runs: ReviewRun[], session: string) => runs.find((r) => r.session === session);

/** "$0.31 of $1.00 today" */
export const spendText = (spent: number, cap: number) => `$${spent.toFixed(2)} of $${cap.toFixed(2)} today`;
