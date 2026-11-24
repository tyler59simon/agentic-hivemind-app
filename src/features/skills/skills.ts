// Pure helpers for the Skills page and the Learned review group: words for states, reliability, and ledger rows.
import type { CopyState, LedgerEntry, PauseKind, ResolveAction, ReviewRun, Skill, SkillProposal } from "../../lib/skills";

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
  sync_from_note: "updated the skill from its note", write_back: "wrote the SKILL.md edit back to the note", sync_paused: "paused sync with the note",
  sync_warning: "hit a sync problem", link: "linked the skill to a note", unlink: "unlinked the skill from its note", resolve_note: "kept the note's text",
  resolve_merge: "saved a merged text", uninstall_remove: "removed a published copy for uninstall",
};
const ACTORS: Record<string, string> = { user: "You", reviewer: "The reviewer", upkeep: "Upkeep", auto: "Hivemind (auto-patch)", sync: "Hivemind (sync)" };

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

/** The skill's link state, for the chip: in step with its note, or paused. Null when it is not linked. */
export function linkState(s: Pick<Skill, "link">): { label: string; tone: "active" | "waiting" } | null {
  if (!s.link) return null;
  return s.link.paused ? { label: "Sync paused", tone: "waiting" } : { label: "Synced with note", tone: "active" };
}

/** The skills whose sync is paused and waits for a choice in the Inbox. */
export const pausedSkills = (skills: Skill[]) => skills.filter((s) => !s.archived && !!s.link?.paused);

export const syncTitle = (name: string) => `Sync paused: ${name}`;

/** The note ref a link points at: the notes list holds `domain:id`. */
export const linkRef = (link: { domain: string; note: string }) => `${link.domain}:${link.note}`;

export const PAUSE_WORDS: Record<PauseKind, string> = {
  conflict: "The note and the skill both changed",
  invalid_note: "The note is missing a section every skill needs",
  invalid_skill: "The skill file is missing a section every skill needs",
  loose_text: "The skill file has text above its first heading",
  copies_differ: "The Claude Code and Codex copies were edited differently",
  note_missing: "The note is gone, archived or no longer a runbook",
};

export interface Choice { enabled: boolean; hint?: string }

/** The four ways to settle a paused skill. All stay enabled for every kind: a pause records the state when sync stopped, the usual
 *  path is to fix one side and then choose, and the backend re-checks the current state and says why when it still cannot. The
 *  hints are guidance shown under the buttons. */
export function pauseChoices(kind: PauseKind): Record<ResolveAction, Choice> {
  const all: Record<ResolveAction, Choice> = { note: { enabled: true }, skill: { enabled: true }, merge: { enabled: true }, unlink: { enabled: true } };
  switch (kind) {
    case "note_missing": return { ...all, note: { enabled: true, hint: "Make the note an active runbook again, then choose Keep the note." } };
    case "copies_differ": return { ...all, skill: { enabled: true, hint: "Make the Claude Code and Codex copies the same, then choose Keep the skill file. A merge replaces both copies." } };
    case "invalid_note": return { ...all, note: { enabled: true, hint: "Add the missing section to the note, then choose Keep the note." } };
    case "invalid_skill": return { ...all, skill: { enabled: true, hint: "Add the missing section to SKILL.md, then choose Keep the skill file." } };
    case "loose_text": return { ...all, skill: { enabled: true, hint: "Move the text under a heading in SKILL.md, then choose Keep the skill file." } };
    default: return all;
  }
}
