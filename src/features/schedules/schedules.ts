// Helpers for Settings > Schedules (CON-20): words for automation runs and triggers, defaults for a new automation, which
// automations are built in, and the per-computer "Show custom automations" switch.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Engine, Role } from "../../lib/agent";
import type { Action, ActionKind, Automation, AutomationRun, Trigger, TriggerKind } from "../../lib/automations";
import { safeStorage } from "../../store";

export const AUTOMATION_RUN_WORDS: Record<AutomationRun["state"], string> = {
  waiting: "Waiting for you", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Cancelled",
};
/** The status-chip class for a state. */
export function tone(state: AutomationRun["state"]): string {
  switch (state) {
    case "running": return "running";
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "waiting": return "waiting";
    default: return "";
  }
}

/** "09:00" for minutes after midnight, and back (null for anything that is not a time). */
export const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
export function minutesOf(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const TRIGGER_LABELS: Record<TriggerKind, string> = {
  every: "Every few hours", daily: "Daily", weekly: "Weekly", session_failed: "When a session fails",
  review_approved: "When you approve a session's edits", commit: "After new commits", manual: "Only when run by hand",
};

/** A trigger of another kind, keeping the time of day where both have one. */
export function triggerOf(kind: TriggerKind, from: Trigger): Trigger {
  const at = "at" in from ? from.at : 9 * 60;
  switch (kind) {
    case "every": return { kind, hours: "hours" in from ? from.hours : 6 };
    case "daily": return { kind, at };
    case "weekly": return { kind, at, days: "days" in from ? from.days : [0] };
    default: return { kind };
  }
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  role: "Start a session in a role", memory_maintenance: "Living Memory maintenance",
  skill_upkeep: "Skill upkeep", commit_capture: "Knowledge from new commits", architecture_check: "Architecture drift check",
  executive_briefing: "Executive briefing", wiki_rebuild: "Rebuild the agent wiki of a project",
};
export const ACTION_HELP: Record<ActionKind, string> = {
  role: "An unattended chat session with the role's own permissions. {event} and {commits} in the instructions are filled in.",
  memory_maintenance: "Runs Living Memory's own maintenance, with its own budget and rules.",
  skill_upkeep: "Proposes archiving skills unused for 30 days or mostly rejected. Nothing is archived until you approve.",
  commit_capture: "The reviewer reads the new commits and drafts notes for Review. Counts against the learning budget.",
  architecture_check: "Runs the Architecture Suite's diff, check and verify on a system and notifies you when its output has drifted. Regenerating stays your decision.",
  executive_briefing: "Writes a briefing from Living Memory and your executive records, about the project picked below or all active projects, and keeps it on Home. Counts against the learning budget.",
  wiki_rebuild: "Rewrites the pages of a project's agent-written wiki whose notes changed, and writes nothing when none did. Made by the Rebuild weekly switch on the project's wiki. The run's budget caps the build and counts against the daily automation budget.",
};

/** An action of another kind with sensible defaults. */
export function actionOf(kind: ActionKind, from: Action, engine: Engine = "claude"): Action {
  if (kind === from.kind) return from;
  switch (kind) {
    case "role": return { kind, role: "reviewer", engine, prompt: "" };
    case "architecture_check": return { kind, system: "" };
    case "executive_briefing": return { kind, briefing: "weekly", days: 7 };
    case "wiki_rebuild": return { kind, domain: "" };
    default: return { kind };
  }
}

/** Whether the action or trigger works on a project's repository. */
export const needsProject = (a: Pick<Automation, "action" | "trigger">) =>
  a.action.kind === "role" || a.action.kind === "commit_capture" || a.trigger.kind === "commit";

/** The automation as saved: a project and repository only where the action uses them; a briefing and a wiki rebuild keep their project alone. */
export const scoped = (a: Automation): Automation =>
  needsProject(a) ? a : a.action.kind === "executive_briefing" || a.action.kind === "wiki_rebuild" ? { ...a, project: a.project || null, repo: null } : { ...a, project: null, repo: null };

/** Roles an automation may start: never a developer (edits with nobody watching). */
export const AUTOMATION_ROLES: Role[] = ["reviewer", "tester", "researcher", "architect"];

export const CAUSE_WORDS: Record<AutomationRun["cause"], string> = {
  schedule: "On schedule", catch_up: "Missed while closed", event: "After an event", commit: "After new commits", manual: "Run by hand",
};

/** "Next: Mon 18 Nov, 09:00" or what starts it otherwise. */
export function nextText(a: Pick<Automation, "enabled" | "nextDue" | "trigger">, now = Date.now()): string {
  if (!a.enabled) return "Off";
  if (a.nextDue == null) return a.trigger.kind === "manual" ? "Runs only by hand" : "Waits for its event";
  if (a.nextDue <= now) return "Due now";
  return `Next: ${new Date(a.nextDue).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** A blank automation to edit. */
export function blankAutomation(project: string | null, repo: string | null, engine: Engine = "claude"): Automation {
  return {
    id: "", name: "", enabled: true, trigger: { kind: "daily", at: 9 * 60 }, action: { kind: "role", role: "reviewer", engine, prompt: "" },
    project, repo, askFirst: false, notify: "failures", budgetUsd: 1, createdAt: 0, lastRun: null, nextDue: null, lastSeen: null,
  };
}

/** The built-in schedules, always shown in Settings > Schedules: briefings, memory maintenance and wiki rebuilds. */
export const BUILT_IN: readonly ActionKind[] = ["executive_briefing", "memory_maintenance", "wiki_rebuild"];
export const builtIn = (a: Pick<Automation, "action">) => BUILT_IN.includes(a.action.kind);

/** Whether Settings > Schedules lists custom automations, kept on this computer. Off by default; hidden ones keep running. */
export const useCustomShown = create<{ shown: boolean; set: (shown: boolean) => void }>()(persist((set) => ({
  shown: false,
  set: (shown) => set({ shown }),
}), { name: "hivemind.schedules.custom", storage: createJSONStorage(() => safeStorage), partialize: (s) => ({ shown: s.shown }) as never }));
export const useShowCustom = () => useCustomShown((s) => s.shown);
export const showCustom = (shown: boolean) => useCustomShown.getState().set(shown);
