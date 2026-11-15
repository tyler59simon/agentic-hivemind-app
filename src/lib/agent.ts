// Agent sessions: Hivemind launches a coding-agent CLI (Claude Code) in the background for one task.
// Rust derives the working folders and the allowed actions from the task; the webview passes the task and the prompt.
import { invoke } from "@tauri-apps/api/core";

export type AgentTask =
  | { kind: "system_passport"; slug: string }
  | { kind: "work"; project: string; repo: string; branch?: string; change?: number }
  /** A folder chosen with `folderPick`; terminal only. It always runs in place. */
  | { kind: "folder"; path: string };
export type SessionStatus = "running" | "waiting" | "idle" | "succeeded" | "failed" | "cancelled" | "ended";
export type SessionMode = "unattended" | "interactive";
export type Policy = "pre_approved" | "ask" | "accept_edits";
export type Decision = "allow" | "allow_always" | "deny" | "withdrawn";
export type TurnOutcome = "completed" | "stopped" | "budget" | "error";
export type Engine = "claude" | "codex";
export type Interface = "chat" | "terminal";
/** Where a work session runs: a new worktree, or the project's own checkout. Chat sessions are worktree only. */
export type Place = "worktree" | "checkout";

export interface Worktree { repo: string; path: string; branch: string; baseBranch: string; baseSha: string; reviewedSha?: string }
/** A session that runs in a folder of the user's own. `startTree` is a git tree of the folder's files at the start. */
export interface Direct { path: string; repo: string | null; headSha: string | null; startTree: string | null }
export interface FileChange { path: string; status: "A" | "M" | "D"; added: number; removed: number; binary?: boolean }
export interface FileTotals { files: number; added: number; removed: number }
export interface FileDiff extends FileChange { diff: string; truncated: boolean }
export interface ChangedFiles { files: FileDiff[]; truncated: boolean }
export interface RepoBranches { current: string | null; branches: string[] }

export type ReviewState = "pending" | "approved" | "changes_requested" | "dismissed";
export interface Review { state: ReviewState; commit: string | null; at: number }
export interface FileContents { base: string | null; head: string | null; binary: boolean; tooLarge: boolean }
export interface ToolOutput { text: string; ok: boolean; truncated: boolean }

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
  review: Review | null; sourceSha: string | null;
  interface: Interface;
  /** The name the user gave the session. */
  name: string | null;
  /** The title the CLI gave its conversation. */
  cliTitle: string | null;
  /** Set when the session runs in the project checkout or another folder, so it has no worktree. */
  direct: Direct | null;
  /** A terminal session started with an empty task. */
  noTask: boolean;
}

/** The engine of a session, whatever adapter name older code stored. */
export const engineOf = (s: Pick<SessionInfo, "adapter">): Engine => (s.adapter === "codex" ? "codex" : "claude");

export interface EngineInfo {
  engine: Engine; label: string; path: string | null; error: string | null; chat: boolean; chatReason: string | null;
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

export interface StartOptions { policy: Policy; context: string[]; briefing?: string; model?: string; system?: string; engine?: Engine; interface?: Interface; place?: Place }
export interface SendOptions { context: string[]; briefing?: string }

export interface SeqEvent { sessionId: string; seq: number; at: number; event: RunEvent }
export interface SessionLog { info: SessionInfo; events: SeqEvent[] }

/** The path of the CLI that would be launched; rejects with a reason the user can act on. */
export const agentAvailable = () => invoke<string>("agent_available");
/** Which engines can be started, Claude Code first, and with which interface. */
export const agentEngines = () => invoke<EngineInfo[]>("agent_engines");
export const agentStart = (task: AgentTask, prompt: string, options?: StartOptions) => invoke<SessionInfo>("agent_start", { task, prompt, options: options ?? null });
export const agentSend = (sessionId: string, text: string, options?: SendOptions) => invoke<void>("agent_send", { sessionId, text, options: options ?? null });
export const agentAnswer = (sessionId: string, requestId: string, decision: Exclude<Decision, "withdrawn">) => invoke<void>("agent_answer", { sessionId, requestId, decision });
export const agentInterrupt = (sessionId: string) => invoke<void>("agent_interrupt", { sessionId });
export const agentEnd = (sessionId: string) => invoke<void>("agent_end", { sessionId });
export const agentFiles = (sessionId: string) => invoke<ChangedFiles>("agent_files", { sessionId });
export const agentSetPolicy = (sessionId: string, policy: Policy) => invoke<void>("agent_set_policy", { sessionId, policy });
/** Name a session (trimmed, at most 80 characters); an empty name clears it. */
export const agentRename = (sessionId: string, name: string) => invoke<void>("agent_rename", { sessionId, name });
export const agentRemoveWorktree = (sessionId: string) => invoke<void>("agent_remove_worktree", { sessionId });
export const repoBranches = (project: string, repo: string) => invoke<RepoBranches>("repo_branches", { project, repo });
export const agentCancel = (sessionId: string) => invoke<void>("agent_cancel", { sessionId });
export const agentSessions = () => invoke<SessionInfo[]>("agent_sessions");
export const agentSession = (sessionId: string, fromSeq = 0) => invoke<SessionLog>("agent_session", { sessionId, fromSeq });

export const reviewFiles = (sessionId: string) => invoke<FileChange[]>("review_files", { sessionId });
export const reviewFile = (sessionId: string, path: string) => invoke<FileContents>("review_file", { sessionId, path });
export const reviewApprove = (sessionId: string, message: string) => invoke<string>("review_approve", { sessionId, message });
export const reviewRequestChanges = (sessionId: string, text: string) => invoke<void>("review_request_changes", { sessionId, text });
export const reviewDismiss = (sessionId: string) => invoke<void>("review_dismiss", { sessionId });
export const reviewDiscard = (sessionId: string) => invoke<void>("review_discard", { sessionId });
/** Have Rust look at every session's worktree again; resolves to how many sessions changed. */
export const reviewRefresh = () => invoke<number>("review_refresh");
export const reviewToolOutput = (sessionId: string, toolUseId: string) => invoke<ToolOutput>("review_tool_output", { sessionId, toolUseId });

/** The commit a session's proposed edits are compared with. */
export const reviewBase = (w: Worktree) => w.reviewedSha ?? w.baseSha;

export const sessionsQuery = () => ({ queryKey: ["agent", "sessions"], queryFn: agentSessions });
export const enginesQuery = () => ({ queryKey: ["agent", "engines"], queryFn: agentEngines, staleTime: 60_000 });
