// Agent sessions: Hivemind launches a coding-agent CLI (Claude Code) in the background for one task.
// Rust derives the working folders and the allowed actions from the task; the webview passes the task and the prompt.
import { invoke } from "@tauri-apps/api/core";

export type AgentTask = { kind: "system_passport"; slug: string };
export type SessionStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface SessionInfo {
  id: string; adapter: string; cliVersion: string | null; task: AgentTask; title: string;
  /** Folders the agent works in; the first is its working directory. */
  workspace: string[];
  status: SessionStatus; startedAt: number; endedAt: number | null; costUsd: number | null; error: string | null;
  /** The structured result the task asked for, once the session has finished. */
  structured: unknown;
}

export type RunEvent =
  | { type: "started"; model: string | null; cliVersion: string | null; plugins: string[] }
  | { type: "text"; text: string }
  | { type: "toolUse"; id: string; name: string; summary: string }
  | { type: "toolResult"; id: string; ok: boolean; summary: string }
  | { type: "denied"; tool: string; summary: string }
  | {
    type: "finished"; status: Exclude<SessionStatus, "running">; reason: string | null; costUsd: number | null;
    durationMs: number | null; turns: number | null; result: string | null; structured: unknown; denials: number;
  };

export interface SeqEvent { sessionId: string; seq: number; at: number; event: RunEvent }
export interface SessionLog { info: SessionInfo; events: SeqEvent[] }

/** The path of the CLI that would be launched; rejects with a reason the user can act on. */
export const agentAvailable = () => invoke<string>("agent_available");
export const agentStart = (task: AgentTask, prompt: string) => invoke<SessionInfo>("agent_start", { task, prompt });
export const agentCancel = (sessionId: string) => invoke<void>("agent_cancel", { sessionId });
export const agentSessions = () => invoke<SessionInfo[]>("agent_sessions");
export const agentSession = (sessionId: string, fromSeq = 0) => invoke<SessionLog>("agent_session", { sessionId, fromSeq });

export const sessionsQuery = () => ({ queryKey: ["agent", "sessions"], queryFn: agentSessions });
