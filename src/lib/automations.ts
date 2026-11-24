// Automations: work Hivemind starts on a schedule or an event, shown in Settings > Schedules. Rust runs them and owns their
// files; these are its commands and the shapes it returns. (Workflows task graphs were deleted in CON-20.)
import { invoke } from "@tauri-apps/api/core";
import type { Engine, Role } from "./agent";
import type { BriefingKind } from "./executive";

export type Trigger =
  | { kind: "every"; hours: number }
  | { kind: "daily"; at: number }
  | { kind: "weekly"; days: number[]; at: number }
  | { kind: "session_failed" } | { kind: "review_approved" } | { kind: "commit" } | { kind: "manual" };
export type TriggerKind = Trigger["kind"];

export type Action =
  | { kind: "role"; role: Role; engine: Engine; prompt: string }
  | { kind: "memory_maintenance" } | { kind: "skill_upkeep" } | { kind: "commit_capture" }
  | { kind: "architecture_check"; system: string }
  | { kind: "executive_briefing"; briefing: BriefingKind; days: number }
  | { kind: "wiki_rebuild"; domain: string };
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
  event: string | null; state: AutomationRunState; detail: string | null; session: string | null;
  costUsd: number | null; endedAt: number | null;
}
export interface AutomationList { automations: AutomationView[]; templates: AutomationView[]; runs: AutomationRun[] }

export const automationList = () => invoke<AutomationList>("automation_list");
export const automationPut = (automation: Automation) => invoke<Automation>("automation_put", { automation });
export const automationDelete = (id: string) => invoke<void>("automation_delete", { id });
/** `run` and `cancel`/`approve` take an automation id and a run id respectively. */
export const automationAct = (action: "run" | "approve" | "cancel", id: string) => invoke<AutomationRun | null>("automation_act", { action, id });

export const automationsQuery = () => ({ queryKey: ["automations"], queryFn: automationList });

/** Today's automation spending against its daily budget (Settings > Spend). */
export interface AutomationSpend { dailyUsd: number; spentToday: number }
export const automationSpend = () => invoke<AutomationSpend>("automation_spend");
export const automationSpendQuery = () => ({ queryKey: ["automations", "spend"], queryFn: automationSpend });
