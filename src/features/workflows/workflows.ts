// Pure helpers for the Workflows page: the task graph's columns, words for states, schedules and automation runs.
import type { Engine, Role } from "../../lib/agent";
import type {
  Action, ActionKind, Automation, AutomationRun, RunState, Task, TaskSpec, TaskState, Trigger, TriggerKind, WorkflowRun,
} from "../../lib/workflows";

/** Tasks in columns by dependency depth: a task sits one column right of its deepest dependency. A task in a cycle or
 *  with a missing dependency (the Rust check refuses both) lands in the last column. */
export function columns<T extends Pick<TaskSpec, "id" | "dependsOn">>(tasks: T[]): T[][] {
  const depth = new Map<string, number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (depth.has(t.id) || !t.dependsOn.every((d) => depth.has(d))) continue;
      depth.set(t.id, Math.max(-1, ...t.dependsOn.map((d) => depth.get(d)!)) + 1);
      changed = true;
    }
  }
  const last = Math.max(-1, ...depth.values()) + 1;
  const out: T[][] = [];
  for (const t of tasks) {
    const d = depth.get(t.id) ?? last;
    (out[d] ??= []).push(t);
  }
  return out.filter(Boolean);
}

export const TASK_WORDS: Record<TaskState, string> = {
  waiting: "Waiting", running: "Running", succeeded: "Done", failed: "Failed", blocked: "Blocked", skipped: "Skipped", cancelled: "Cancelled",
};
export const AUTOMATION_RUN_WORDS: Record<AutomationRun["state"], string> = {
  waiting: "Waiting for you", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Cancelled",
};
export const RUN_WORDS: Record<RunState, string> = { planned: "Not started", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Cancelled" };

/** The status-chip class for a state. */
export function tone(state: TaskState | RunState | AutomationRun["state"]): string {
  switch (state) {
    case "running": return "running";
    case "succeeded": return "succeeded";
    case "failed": case "blocked": return "failed";
    case "waiting": case "planned": return "waiting";
    default: return "";
  }
}

/** "2 of 4 tasks done". */
export function progressText(run: Pick<WorkflowRun, "tasks">): string {
  const done = run.tasks.filter((t) => t.state === "succeeded" || t.state === "skipped").length;
  return `${done} of ${run.tasks.length} task${run.tasks.length === 1 ? "" : "s"} done`;
}

/** What the user can do with a task now. */
export function taskActions(run: Pick<WorkflowRun, "state">, task: Pick<Task, "state">): ("retry" | "skip")[] {
  if (run.state === "planned" || run.state === "cancelled") return [];
  if (task.state === "failed" || task.state === "blocked") return ["retry", "skip"];
  return [];
}

/** A task id from a title: lower case, letters and digits joined by "-", unique among `taken`. */
export function taskId(title: string, taken: string[]): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "task";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Remove a task and every reference to it. */
export function withoutTask(tasks: TaskSpec[], id: string): TaskSpec[] {
  return tasks.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id), from: t.from === id ? null : t.from }));
}

/** Toggle a dependency; dropping the one a task starts from also clears `from`. */
export function toggleDependency(task: TaskSpec, on: string): TaskSpec {
  if (task.dependsOn.includes(on)) return { ...task, dependsOn: task.dependsOn.filter((d) => d !== on), from: task.from === on ? null : task.from };
  return { ...task, dependsOn: [...task.dependsOn, on] };
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
  role: "Start a session in a role", workflow: "Start a workflow", memory_maintenance: "Living Memory maintenance",
  skill_upkeep: "Skill upkeep", commit_capture: "Knowledge from new commits", architecture_check: "Architecture drift check",
  executive_briefing: "Executive briefing",
};
export const ACTION_HELP: Record<ActionKind, string> = {
  role: "An unattended chat session with the role's own permissions. {event} and {commits} in the instructions are filled in.",
  workflow: "A workflow from a template, unattended. Editing tasks leave their edits on branches for you to approve.",
  memory_maintenance: "Runs Living Memory's own maintenance, with its own budget and rules.",
  skill_upkeep: "Proposes archiving skills unused for 30 days or mostly rejected. Nothing is archived until you approve.",
  commit_capture: "The reviewer reads the new commits and drafts notes for Review. Counts against the learning budget.",
  architecture_check: "Runs the Architecture Suite's diff, check and verify on a system and notifies you when its output has drifted. Regenerating stays your decision.",
  executive_briefing: "Writes a briefing from Living Memory and your executive records, about the project picked below or all active projects, and keeps it on the Executive page. Counts against the learning budget.",
};

/** An action of another kind with sensible defaults. */
export function actionOf(kind: ActionKind, from: Action, engine: Engine = "claude"): Action {
  if (kind === from.kind) return from;
  switch (kind) {
    case "role": return { kind, role: "reviewer", engine, prompt: "" };
    case "workflow": return { kind, template: "review", goal: "" };
    case "architecture_check": return { kind, system: "" };
    case "executive_briefing": return { kind, briefing: "weekly", days: 7 };
    default: return { kind };
  }
}

/** Whether the action or trigger works on a project's repository. */
export const needsProject = (a: Pick<Automation, "action" | "trigger">) =>
  a.action.kind === "role" || a.action.kind === "workflow" || a.action.kind === "commit_capture" || a.trigger.kind === "commit";

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
