// Agent sessions: Hivemind launches a coding-agent CLI (Claude Code) in the background for one task.
// Rust derives the working folders and the allowed actions from the task; the webview passes the task and the prompt.
import { invoke } from "@tauri-apps/api/core";

export type AgentTask =
  | { kind: "system_passport"; slug: string }
  | { kind: "work"; project: string; repo: string; branch?: string; change?: number };
export type SessionStatus = "running" | "waiting" | "idle" | "succeeded" | "failed" | "cancelled" | "ended";
export type SessionMode = "unattended" | "interactive";
export type Policy = "pre_approved" | "ask" | "accept_edits";
export type Decision = "allow" | "allow_always" | "deny" | "withdrawn";
export type TurnOutcome = "completed" | "stopped" | "budget" | "error";

export interface Worktree { repo: string; path: string; branch: string; baseBranch: string; baseSha: string }
export interface FileChange { path: string; status: "A" | "M" | "D"; added: number; removed: number; binary?: boolean }
export interface FileTotals { files: number; added: number; removed: number }
export interface FileDiff extends FileChange { diff: string; truncated: boolean }
export interface ChangedFiles { files: FileDiff[]; truncated: boolean }
export interface RepoBranches { current: string | null; branches: string[] }

export interface SessionInfo {
  id: string; adapter: string; cliVersion: string | null; task: AgentTask; title: string;
  /** Folders the agent works in; the first is its working directory. */
  workspace: string[];
  status: SessionStatus; startedAt: number; endedAt: number | null; costUsd: number | null; error: string | null;
  /** The structured result the task asked for, once the session has finished. */
  structured: unknown;
  mode: SessionMode; policy: Policy; project: string | null; worktree: Worktree | null;
  turns: number; filesChanged: FileTotals | null;
  context: string[]; model: string | null; system: string | null;
}

export type RunEvent =
  | { type: "started"; model: string | null; cliVersion: string | null; plugins: string[] }
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; summary: string }
  | { type: "toolResult"; id: string; ok: boolean; summary: string }
  | { type: "denied"; tool: string; summary: string }
  | { type: "userMessage"; text: string; context: string[] }
  | { type: "approvalRequest"; requestId: string; tool: string; summary: string; input: unknown; canAlways: boolean; alwaysLabel: string | null }
  | { type: "approvalResolved"; requestId: string; decision: Decision }
  | { type: "turnFinished"; ok: boolean; reason: string | null; costUsd: number | null; durationMs: number | null; result: string | null; denials: number; outcome: TurnOutcome }
  | { type: "filesChanged"; files: FileChange[] }
  | {
    type: "finished"; status: Exclude<SessionStatus, "running" | "waiting" | "idle">; reason: string | null; costUsd: number | null;
    durationMs: number | null; turns: number | null; result: string | null; structured: unknown; denials: number;
  };

export interface StartOptions { policy: Policy; context: string[]; briefing?: string; model?: string; system?: string }
export interface SendOptions { context: string[]; briefing?: string }

export interface SeqEvent { sessionId: string; seq: number; at: number; event: RunEvent }
export interface SessionLog { info: SessionInfo; events: SeqEvent[] }

/** The path of the CLI that would be launched; rejects with a reason the user can act on. */
export const agentAvailable = () => invoke<string>("agent_available");
export const agentStart = (task: AgentTask, prompt: string, options?: StartOptions) => invoke<SessionInfo>("agent_start", { task, prompt, options: options ?? null });
export const agentSend = (sessionId: string, text: string, options?: SendOptions) => invoke<void>("agent_send", { sessionId, text, options: options ?? null });
export const agentAnswer = (sessionId: string, requestId: string, decision: Exclude<Decision, "withdrawn">) => invoke<void>("agent_answer", { sessionId, requestId, decision });
export const agentInterrupt = (sessionId: string) => invoke<void>("agent_interrupt", { sessionId });
export const agentEnd = (sessionId: string) => invoke<void>("agent_end", { sessionId });
export const agentFiles = (sessionId: string) => invoke<ChangedFiles>("agent_files", { sessionId });
export const agentSetPolicy = (sessionId: string, policy: Policy) => invoke<void>("agent_set_policy", { sessionId, policy });
export const agentRemoveWorktree = (sessionId: string) => invoke<void>("agent_remove_worktree", { sessionId });
export const repoBranches = (project: string, repo: string) => invoke<RepoBranches>("repo_branches", { project, repo });
export const agentCancel = (sessionId: string) => invoke<void>("agent_cancel", { sessionId });
export const agentSessions = () => invoke<SessionInfo[]>("agent_sessions");
export const agentSession = (sessionId: string, fromSeq = 0) => invoke<SessionLog>("agent_session", { sessionId, fromSeq });

export const sessionsQuery = () => ({ queryKey: ["agent", "sessions"], queryFn: agentSessions });
