// The executive workspace's records and calls. Operational records (milestones, health, stakeholders, briefings and
// capture batches) live in Hivemind's app data through these commands; durable knowledge stays in Living Memory (lib/lm.ts).
// Rust builds every prompt and gathers the evidence; the webview names the task and sends what the user typed.
import { invoke } from "@tauri-apps/api/core";
import type { SessionInfo, StartOptions } from "./agent";

export type RecordKind = "milestone" | "health" | "stakeholder" | "briefing" | "capture";
interface Stamped { id: string; created: number; updated: number }

export type MilestoneStatus = "planned" | "at_risk" | "done" | "missed";
export interface Milestone extends Stamped { project: string; title: string; due: string; status: MilestoneStatus; note: string }
export type HealthStatus = "green" | "amber" | "red";
/** The user's call on a project's health; the id is the project slug. */
export interface Health extends Stamped { project: string; status: HealthStatus; note: string }
export interface Stakeholder extends Stamped { name: string; role: string; email: string; projects: string[]; notes: string }

/** One fact a generated text may cite. `ref` is a note ref, or `milestone:<id>` / `health:<slug>`. */
export interface Evidence { id: string; kind: string; title: string; project?: string | null; ref?: string | null; date?: string | null; text: string }

export const BRIEFING_KINDS = ["weekly", "project", "priorities", "commitments", "risks"] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];
export const BRIEFING_LABEL: Record<BriefingKind, string> = {
  weekly: "Weekly leadership report", project: "Project summary", priorities: "Priorities", commitments: "Outstanding commitments", risks: "Risk assessment",
};
export interface Bullet { text: string; evidence: string[] }
export interface Briefing extends Stamped {
  kind: BriefingKind; project: string | null; days: number; origin: string;
  title: string; summary: string; sections: { heading: string; bullets: Bullet[] }[];
  /** What the model said is missing, and what the evidence pack found missing. */
  gaps: string[]; packGaps: string[]; evidence: Evidence[]; costUsd: number | null;
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
  /** An accept that started and has not been recorded: the exact write (features/executive/items.ts Write), saved before it
   *  ran, so a retry repeats it instead of planning another one from edited fields. */
  intent?: { write: unknown; superseded?: string };
}
export interface CaptureSource { kind: "paste" | "agent-session"; label: string; session?: string }
export interface CaptureBatch extends Stamped { source: CaptureSource; project: string | null; text: string; items: CaptureItem[]; questions: string[]; costUsd: number | null }

export const listRecords = <T>(kind: RecordKind) => invoke<T[]>("exec_list", { kind });
export const putRecord = <T>(kind: RecordKind, record: Partial<T>) => invoke<T>("exec_put", { kind, record });
export const deleteRecord = (kind: RecordKind, id: string) => invoke<void>("exec_delete", { kind, id });
export const recordsQuery = <T>(kind: RecordKind) => ({ queryKey: ["executive", kind], queryFn: () => listRecords<T>(kind) });

export const brief = (kind: BriefingKind, project: string | null, days: number) => invoke<Briefing>("exec_brief", { kind, project, days });
/** Null: nothing worth keeping was found. */
export const extract = (text: string, project: string | null, label?: string) => invoke<CaptureBatch | null>("exec_extract", { text, project, label });
export const agentStart = (project: string | null, prompt: string, options: Pick<StartOptions, "engine" | "model">) =>
  invoke<SessionInfo>("exec_agent_start", { project, prompt, options });
export const sessionCapture = (id: string) => invoke<CaptureBatch | null>("exec_session_capture", { id });
export type ExportFormat = "md" | "txt";
/** Null when the user cancelled the save dialog. */
export const exportText = (name: string, format: ExportFormat, content: string) => invoke<string | null>("exec_export", { name, format, content });
