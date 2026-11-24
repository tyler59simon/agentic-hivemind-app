// Skills Hivemind keeps for Claude Code and Codex, and the post-session reviewer that proposes them. Rust owns the files;
// these are its commands and the shapes it returns.
import { invoke } from "@tauri-apps/api/core";

export type SkillKind = "create" | "patch" | "archive";
export type ProposalState = "pending" | "approved" | "rejected";
/** A published copy: current, an older version, edited outside Hivemind, or gone. */
export type CopyState = "current" | "older" | "edited" | "missing";

export interface SkillCopy { dir: string; state: CopyState }

/** Why sync stopped for a linked skill. */
export type PauseKind = "conflict" | "invalid_note" | "invalid_skill" | "loose_text" | "copies_differ" | "note_missing";
export interface SkillText { description: string; body: string }
export interface Pause { kind: PauseKind; reason: string; at: number; noteText: SkillText | null; skillText: SkillText | null }
/** The two-way link between a skill and its runbook note, with what both held at the last sync. */
export interface Link { note: string; domain: string; title: string; revision: string; noteDigest: string; version: number; paused: Pause | null }

export interface Skill {
  name: string; description: string; version: number; archived: boolean; createdAt: number; updatedAt: number;
  notes: string[]; sessions: string[];
  body: string; versions: number[]; copies: SkillCopy[];
  uses: number; lastUsed: number | null; approved: number; rejected: number; reliability: number | null;
  stale: boolean; flagged: boolean;
  link: Link | null;
}

export interface SkillProposal {
  id: string; kind: SkillKind; name: string; description: string; body: string; reason: string;
  baseVersion: number | null; session: string | null; sessionTitle: string | null; note: string | null;
  by: "reviewer" | "upkeep" | "user"; state: ProposalState; createdAt: number; decidedAt: number | null; decision: string | null;
  /** Set on an approval whose version was stored but not published everywhere. */
  warning?: string | null;
  /** A proposal from a runbook note: approving it links the skill to the note. */
  link: boolean;
  noteRevision: string | null; noteDigest: string | null; noteDomain: string | null; noteTitle: string | null;
}

export interface LedgerEntry {
  at: number; actor: string; action: string; name: string; version: number | null; sha256: string | null; proposal: string | null; detail: string | null;
  revision?: string | null;
}

export type ReviewTrigger = "approved" | "dismissed" | "finished" | "manual";
export interface ReviewRun {
  session: string; title: string; at: number; trigger: ReviewTrigger; state: "staged" | "nothing" | "failed";
  memory: { id: string; title: string }[]; skill: string | null; skillName: string | null; skillApplied: boolean;
  costUsd: number | null; error: string | null;
}

export interface LearningStatus { enabled: boolean; dailyUsd: number; spentToday: number; reviewUsd: number; autoPatch: boolean; runs: ReviewRun[] }

export const learningStatus = () => invoke<LearningStatus>("learning_status");
export const learningReview = (id: string) => invoke<void>("learning_review", { id });
export const skillsList = () => invoke<Skill[]>("skills_list");
export const skillProposals = (all = false) => invoke<SkillProposal[]>("skill_proposals", { all });
export const skillDecide = (id: string, approve: boolean, opts: { description?: string; body?: string; reason?: string } = {}) =>
  invoke<SkillProposal>("skill_decide", { id, approve, description: opts.description ?? null, body: opts.body ?? null, reason: opts.reason ?? null });
export const skillAction = (name: string, action: "archive" | "restore" | "import" | "publish", version?: number) =>
  invoke<void>("skill_action", { name, action, version: version ?? null });
export const skillVersion = (name: string, version: number) => invoke<string>("skill_version", { name, version });
export const skillHistory = (name?: string) => invoke<LedgerEntry[]>("skill_history", { name: name ?? null });
export const skillsUpkeep = () => invoke<SkillProposal[]>("skills_upkeep");
export const skillFromNote = (note: string) => invoke<SkillProposal>("skill_from_note", { note });

export type ResolveAction = "note" | "skill" | "merge" | "unlink";
/** Sync every linked skill now; resolves to how many changed. The backend also emits `skills-changed` when any did. */
export const skillsSyncNow = () => invoke<number>("skills_sync");
export const skillLink = (name: string, note: string) => invoke<Skill>("skill_link", { name, note });
export const skillUnlink = (name: string) => invoke<void>("skill_unlink", { name });
export const skillResolve = (name: string, action: ResolveAction, text?: SkillText) =>
  invoke<Skill>("skill_resolve", { name, action, description: text?.description ?? null, body: text?.body ?? null });

/** A skill copy Hivemind published, listed before an uninstall (REG-10). */
export interface Published { name: string; dir: string; state: CopyState; removable: boolean; reason: string | null }
export interface RemoveReport { removed: string[]; kept: Published[] }
export const uninstallSkills = () => invoke<Published[]>("uninstall_skills");
export const uninstallRemoveSkills = () => invoke<RemoveReport>("uninstall_remove_skills");

export const learningQuery = () => ({ queryKey: ["learning", "status"], queryFn: learningStatus });
export const skillsQuery = () => ({ queryKey: ["skills", "list"], queryFn: skillsList });
export const skillProposalsQuery = () => ({ queryKey: ["skills", "proposals"], queryFn: () => skillProposals() });
