// Pure helpers behind the Start screen: the options the form builds, the modes' words, and the same-folder check.
import {
  accessLabel, asksNobody, type Access, type AgentModels, type AgentTask, type ClaudeMode, type Engine, type Interface, type Policy,
  type SessionInfo, type StartOptions, type Approval, type Sandbox,
} from "../../lib/agent";
import { samePath } from "../../lib/folders";
import { isEnded } from "./session";

/** Where a terminal runs: the project's checkout, a new worktree of it, or a folder the user picked. */
export type Where = "checkout" | "worktree" | "folder";

export const WHERE_HELP: Record<Where, string> = {
  checkout: "Works in your real files, like the CLI in a terminal.",
  worktree: "A copy on its own branch; you review and merge it.",
  folder: "Any folder on this computer.",
};

export const CLAUDE_DEFAULT: Access = { engine: "claude", mode: "manual" };
export const CODEX_DEFAULT: Access = { engine: "codex", sandbox: "read-only", approval: "on-request" };
export const defaultAccess = (engine: Engine): Access => (engine === "claude" ? CLAUDE_DEFAULT : CODEX_DEFAULT);

/** A short sentence for each CLI mode; the names themselves are the CLI's. */
export const MODE_HELP: Record<ClaudeMode | Sandbox | Approval, string> = {
  manual: "Asks before edits and commands.",
  acceptEdits: "Edits apply without asking; commands ask.",
  plan: "Plans first and changes nothing until you approve the plan.",
  auto: "A classifier lets safe actions run and blocks risky ones.",
  dontAsk: "Does not ask: runs what your settings allow and refuses the rest.",
  bypassPermissions: "Skips every permission check.",
  "read-only": "Can read files but not change them.",
  "workspace-write": "Can change files in the folder.",
  "danger-full-access": "No sandbox: can change anything on this computer.",
  "on-request": "Asks when it needs to go beyond the sandbox.",
  never: "Never asks; runs whatever the sandbox allows.",
  "approve-for-me": "Codex's automatic reviewer answers approvals, not you. Sandbox is workspace-write.",
};

/** What the Start screen says is allowed for an access: its label, then one line per setting. */
export function accessLines(access: Access): string[] {
  return access.engine === "claude"
    ? [accessLabel(access), MODE_HELP[access.mode]]
    : [accessLabel(access), MODE_HELP[access.sandbox], MODE_HELP[access.approval]];
}

/** Codex with an approval chosen: `approve-for-me` needs the workspace-write sandbox, so it sets it. */
export function withApproval(access: Extract<Access, { engine: "codex" }>, approval: Approval): Access {
  return { ...access, approval, sandbox: approval === "approve-for-me" ? "workspace-write" : access.sandbox };
}

/** The efforts to offer for a model; with no model chosen, the CLI's default model's, else every effort any model has. */
export function effortOptions(models: AgentModels | undefined, model: string): string[] {
  if (!models) return [];
  const named = models.models.find((m) => m.id === (model || models.defaultModel));
  if (named) return named.efforts;
  return [...new Set(models.models.flatMap((m) => m.efforts))];
}

/** The terminal sessions still open (running or idle) in a folder: starting another there makes the two collide. */
export function terminalsIn(sessions: SessionInfo[], path: string): SessionInfo[] {
  return sessions.filter((s) => s.interface === "terminal" && !isEnded(s) && !!s.direct && samePath(s.direct.path, path));
}

export interface StartForm {
  engine: Engine; face: Interface; where: Where;
  /** The picked project's slug; null under "Other folders". */
  project: string | null; repo: string; branch: string; change: number | null; folder: string | null;
  task: string; policy: Policy; access: Access; model: string; effort: string;
  context: string[]; briefing?: string; system?: string;
}

/** What `agentStart` is called with. The task text is trimmed; a terminal may have none. */
export function buildStart(f: StartForm): { task: AgentTask; prompt: string; options: StartOptions } {
  const prompt = f.task.trim();
  const change = f.change !== null ? { change: f.change } : {};
  if (f.face === "chat") {
    if (!f.project) throw new Error("Chat needs a project");
    return {
      task: { kind: "work", project: f.project, repo: f.repo, branch: f.branch, ...change }, prompt,
      options: { policy: f.policy, context: f.context, briefing: f.briefing, model: f.engine === "claude" ? f.model || undefined : undefined, system: f.system, engine: f.engine, interface: "chat" },
    };
  }
  const folder = f.where === "folder" || !f.project;
  if (folder && !f.folder) throw new Error("Pick a folder");
  const options: StartOptions = {
    policy: f.policy, context: folder ? [] : f.context, engine: f.engine, interface: "terminal", access: f.access,
    ...(folder ? {} : { briefing: f.briefing, system: f.system, place: f.where === "worktree" ? "worktree" as const : "checkout" as const }),
    ...(f.model ? { model: f.model } : {}), ...(f.effort ? { effort: f.effort } : {}),
    ...(asksNobody(f.access) ? { confirmedRisky: true } : {}),
  };
  const task: AgentTask = folder ? { kind: "folder", path: f.folder! }
    : { kind: "work", project: f.project!, repo: f.repo, ...(f.where === "worktree" ? { branch: f.branch } : {}), ...change };
  return { task, prompt, options };
}
