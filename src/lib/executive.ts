// The executive workspace's records and calls. Operational records (milestones, health, stakeholders, drafts, briefings and
// capture batches) live in Hivemind's app data through these commands; durable knowledge stays in Living Memory (lib/lm.ts).
// Rust builds every prompt and gathers the evidence; the webview names the task and sends what the user typed.
import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo, StartOptions } from "./agent";

export type RecordKind = "milestone" | "health" | "stakeholder" | "draft" | "briefing" | "capture";
interface Stamped { id: string; created: number; updated: number }

export type MilestoneStatus = "planned" | "at_risk" | "done" | "missed";
export interface Milestone extends Stamped { project: string; title: string; due: string; status: MilestoneStatus; note: string }
export type HealthStatus = "green" | "amber" | "red";
/** The user's call on a project's health; the id is the project slug. */
export interface Health extends Stamped { project: string; status: HealthStatus; note: string }
export interface Stakeholder extends Stamped { name: string; role: string; email: string; projects: string[]; notes: string }

/** One fact a generated text may cite. `ref` is a note ref, or `milestone:<id>` / `health:<slug>`. */
export interface Evidence { id: string; kind: string; title: string; project?: string | null; ref?: string | null; date?: string | null; text: string }
export interface Pack { evidence: Evidence[]; gaps: string[] }

export const BRIEFING_KINDS = ["weekly", "project", "priorities", "commitments", "risks"] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];
export interface Bullet { text: string; evidence: string[] }
export interface Briefing extends Stamped {
  kind: BriefingKind; project: string | null; days: number; origin: string;
  title: string; summary: string; sections: { heading: string; bullets: Bullet[] }[];
  /** What the model said is missing, and what the evidence pack found missing. */
  gaps: string[]; packGaps: string[]; evidence: Evidence[]; costUsd: number | null;
}

export const DRAFT_KINDS = ["email", "stakeholder update", "escalation", "executive summary"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export interface Generated { subject: string; body: string; evidence: Evidence[]; assumptions: string[]; gaps: string[]; packGaps?: string[]; costUsd: number | null }
export interface DraftVersion { at: number; subject: string; body: string; note: string }
export interface Draft extends Stamped {
  kind: DraftKind; channel: "email" | "message" | "document"; audience: string; tone: string; points: string; project: string | null;
  subject: string; body: string;
  /** The text as generated (or last refined), for learning from the user's edits. */
  generated: string; evidence: Evidence[]; assumptions: string[]; gaps: string[]; versions: DraftVersion[];
  /** The generated text the style learner last read, so one set of edits is learned from once. */
  learnedFrom?: string;
}

export const ITEM_KINDS = ["decision", "risk", "commitment", "status", "milestone", "knowledge", "preference"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export interface Similar { ref: string; title: string; type: string }
export type ItemState = "pending" | "accepted" | "rejected";
export interface CaptureItem {
  id: string; kind: ItemKind; project: string | null; title: string; summary: string; details: string[];
  owner: string; due: string; quote: string; confidence: "high" | "medium" | "low";
  similar: Similar[]; state: ItemState;
  /** What accepting wrote: a note ref, `milestone:<id>`, and the operation to undo. */
  result?: { ref?: string; operation?: string; superseded?: string };
}
export interface CaptureSource { kind: "paste" | "agent-session" | "draft-edits"; label: string; session?: string }
export interface CaptureBatch extends Stamped { source: CaptureSource; project: string | null; text: string; items: CaptureItem[]; questions: string[]; costUsd: number | null }

export const listRecords = <T>(kind: RecordKind) => invoke<T[]>("exec_list", { kind });
export const putRecord = <T>(kind: RecordKind, record: Partial<T>) => invoke<T>("exec_put", { kind, record });
export const deleteRecord = (kind: RecordKind, id: string) => invoke<void>("exec_delete", { kind, id });
export const recordsQuery = <T>(kind: RecordKind) => ({ queryKey: ["executive", kind], queryFn: () => listRecords<T>(kind) });

export const pack = (project: string | null, days?: number) => invoke<Pack>("exec_pack", { project, days });
export const brief = (kind: BriefingKind, project: string | null, days: number) => invoke<Briefing>("exec_brief", { kind, project, days });
export interface DraftRequest { kind: DraftKind; audience: string; tone: string; points: string; project: string | null }
export const draft = (request: DraftRequest) => invoke<Generated>("exec_draft", { request });
export const refine = (subject: string, body: string, evidence: Evidence[], instruction: string) =>
  invoke<Generated>("exec_refine", { subject, body, evidence, instruction });
/** Null: nothing worth keeping was found. */
export const extract = (text: string, project: string | null, label?: string) => invoke<CaptureBatch | null>("exec_extract", { text, project, label });
export const learnStyle = (generated: string, kept: string, label: string) => invoke<void>("exec_learn_style", { generated, kept, label });
export const agentStart = (project: string | null, prompt: string, options: Pick<StartOptions, "engine" | "model">) =>
  invoke<SessionInfo>("exec_agent_start", { project, prompt, options });
export const sessionCapture = (id: string) => invoke<CaptureBatch | null>("exec_session_capture", { id });
export type ExportFormat = "md" | "txt" | "eml";
/** Null when the user cancelled the save dialog. */
export const exportText = (name: string, format: ExportFormat, content: string) => invoke<string | null>("exec_export", { name, format, content });
