// Workflows (a goal as a graph of role sessions) and automations (work Hivemind starts on a schedule or an event). Rust
// runs both and owns their files; these are its commands and the shapes it returns.
import { invoke } from "@tauri-apps/api/core";
import type { Engine, Role, Verdict } from "./agent";
import type { BriefingKind } from "./executive";

export type TaskState = "waiting" | "running" | "succeeded" | "failed" | "blocked" | "skipped" | "cancelled";
export type RunState = "planned" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskSpec {
  id: string; role: Role; engine: Engine; title: string; prompt: string; dependsOn: string[];
  /** The task whose checkpoint this task's worktree starts from; must be one of dependsOn. */
  from: string | null;
}
export interface Task extends TaskSpec {
  state: TaskState; session: string | null; branch: string | null; checkpoint: string | null;
  files: number; summary: string | null; verdict: Verdict | null; error: string | null;
}
export interface WorkflowRun {
  id: string; goal: string; project: string; repo: string; baseBranch: string | null; template: string | null;
  model: string | null; unattended: boolean; budgetUsd: number | null; origin: string | null;
  state: RunState; tasks: Task[]; createdAt: number; endedAt: number | null;
}
export interface NewRun {
  goal: string; project: string; repo: string; baseBranch: string | null; template: string | null;
  model: string | null; unattended: boolean; budgetUsd: number | null; tasks: TaskSpec[];
}
export interface WorkflowTemplate { id: string; name: string; description: string; tasks: TaskSpec[] }
export type WorkflowAction = "start" | "cancel" | "retry" | "skip";

export type Trigger =
  | { kind: "every"; hours: number }
  | { kind: "daily"; at: number }
  | { kind: "weekly"; days: number[]; at: number }
  | { kind: "session_failed" } | { kind: "review_approved" } | { kind: "commit" } | { kind: "manual" };
export type TriggerKind = Trigger["kind"];

export type Action =
  | { kind: "role"; role: Role; engine: Engine; prompt: string }
  | { kind: "workflow"; template: string; goal: string }
  | { kind: "memory_maintenance" } | { kind: "skill_upkeep" } | { kind: "commit_capture" }
  | { kind: "architecture_check"; system: string }
  | { kind: "executive_briefing"; briefing: BriefingKind; days: number };
export type ActionKind = Action["kind"];
export type Notify = "all" | "failures" | "none";

export interface Automation {
  id: string; name: string; enabled: boolean; trigger: Trigger; action: Action;
  project: string | null; repo: string | null; askFirst: boolean; notify: Notify; budgetUsd: number | null;
  createdAt: number; lastRun: number | null; nextDue: number | null; lastSeen: string | null;
}
export interface AutomationView extends Automation { triggerText: string }
export type AutomationRunState = "waiting" | "running" | "succeeded" | "failed" | "cancelled";
export interface AutomationRun {
  id: string; automation: string; at: number; cause: "schedule" | "catch_up" | "event" | "commit" | "manual";
  event: string | null; state: AutomationRunState; detail: string | null; session: string | null; workflow: string | null;
  costUsd: number | null; endedAt: number | null;
}
export interface AutomationList { automations: AutomationView[]; templates: AutomationView[]; runs: AutomationRun[] }

export const workflowTemplates = () => invoke<WorkflowTemplate[]>("workflow_templates");
export const workflowList = () => invoke<WorkflowRun[]>("workflow_list");
export const workflowCreate = (run: NewRun) => invoke<WorkflowRun>("workflow_create", { run });
export const workflowEdit = (id: string, tasks: TaskSpec[]) => invoke<WorkflowRun>("workflow_edit", { id, tasks });
export const workflowAct = (id: string, action: WorkflowAction, task?: string) => invoke<WorkflowRun>("workflow_act", { id, action, task: task ?? null });
export const workflowDelete = (id: string) => invoke<void>("workflow_delete", { id });
export const workflowReport = (id: string) => invoke<string>("workflow_report", { id });

export const automationList = () => invoke<AutomationList>("automation_list");
export const automationPut = (automation: Automation) => invoke<Automation>("automation_put", { automation });
export const automationDelete = (id: string) => invoke<void>("automation_delete", { id });
/** `run` and `cancel`/`approve` take an automation id and a run id respectively. */
export const automationAct = (action: "run" | "approve" | "cancel", id: string) => invoke<AutomationRun | null>("automation_act", { action, id });

export const workflowTemplatesQuery = () => ({ queryKey: ["workflows", "templates"], queryFn: workflowTemplates, staleTime: Infinity });
export const workflowsQuery = () => ({ queryKey: ["workflows", "list"], queryFn: workflowList });
export const automationsQuery = () => ({ queryKey: ["automations"], queryFn: automationList });
