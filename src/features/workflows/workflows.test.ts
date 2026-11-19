import { describe, expect, it } from "vitest";
import type { TaskSpec } from "../../lib/workflows";
import { actionOf, blankAutomation, clock, columns, minutesOf, needsProject, nextText, progressText, taskActions, taskId, toggleDependency, triggerOf, withoutTask } from "./workflows";

const spec = (id: string, dependsOn: string[] = [], from: string | null = null): TaskSpec =>
  ({ id, role: "developer", engine: "claude", title: id, prompt: "p", dependsOn, from });

describe("columns", () => {
  it("puts each task one column right of its deepest dependency", () => {
    const cols = columns([spec("plan"), spec("build", ["plan"]), spec("review", ["build"]), spec("test", ["build", "plan"])]);
    expect(cols.map((c) => c.map((t) => t.id))).toEqual([["plan"], ["build"], ["review", "test"]]);
  });
  it("puts parallel tasks together and unresolvable ones last", () => {
    expect(columns([spec("a"), spec("b")]).map((c) => c.length)).toEqual([2]);
    expect(columns([spec("a"), spec("x", ["y"]), spec("y", ["x"])]).map((c) => c.map((t) => t.id))).toEqual([["a"], ["x", "y"]]);
  });
});

describe("task editing", () => {
  it("makes unique ids from titles", () => {
    expect(taskId("Review the change!", [])).toBe("review-the-change");
    expect(taskId("Plan", ["plan", "plan-2"])).toBe("plan-3");
    expect(taskId("???", [])).toBe("task");
  });
  it("removes a task and its references", () => {
    const left = withoutTask([spec("a"), spec("b", ["a"], "a")], "a");
    expect(left).toEqual([spec("b")]);
  });
  it("drops the start point with its dependency", () => {
    expect(toggleDependency(spec("b", ["a"], "a"), "a")).toEqual(spec("b"));
    expect(toggleDependency(spec("b"), "a").dependsOn).toEqual(["a"]);
  });
});

describe("run words", () => {
  it("counts done and skipped tasks", () => {
    const t = (state: string) => ({ state }) as never;
    expect(progressText({ tasks: [t("succeeded"), t("skipped"), t("failed")] })).toBe("2 of 3 tasks done");
  });
  it("offers retry and skip on failed or blocked tasks of a started run", () => {
    expect(taskActions({ state: "failed" }, { state: "blocked" })).toEqual(["retry", "skip"]);
    expect(taskActions({ state: "running" }, { state: "running" })).toEqual([]);
    expect(taskActions({ state: "cancelled" }, { state: "failed" })).toEqual([]);
  });
});

describe("schedules", () => {
  it("reads and writes times of day", () => {
    expect(clock(9 * 60 + 5)).toBe("09:05");
    expect(minutesOf("18:30")).toBe(18 * 60 + 30);
    expect(minutesOf("24:00")).toBeNull();
    expect(minutesOf("9")).toBeNull();
  });
  it("keeps the time when the trigger kind changes", () => {
    expect(triggerOf("weekly", { kind: "daily", at: 600 })).toEqual({ kind: "weekly", at: 600, days: [0] });
    expect(triggerOf("every", { kind: "daily", at: 600 })).toEqual({ kind: "every", hours: 6 });
    expect(triggerOf("commit", { kind: "every", hours: 2 })).toEqual({ kind: "commit" });
  });
  it("says when an automation runs next", () => {
    expect(nextText({ enabled: false, nextDue: 5, trigger: { kind: "daily", at: 0 } })).toBe("Off");
    expect(nextText({ enabled: true, nextDue: null, trigger: { kind: "commit" } })).toBe("Waits for its event");
    expect(nextText({ enabled: true, nextDue: 5, trigger: { kind: "daily", at: 0 } }, 10)).toBe("Due now");
    expect(nextText({ enabled: true, nextDue: 50, trigger: { kind: "daily", at: 0 } }, 10)).toMatch(/^Next: /);
  });
});

describe("actions", () => {
  it("knows which automations need a project", () => {
    expect(needsProject({ action: { kind: "memory_maintenance" }, trigger: { kind: "daily", at: 0 } })).toBe(false);
    expect(needsProject({ action: { kind: "skill_upkeep" }, trigger: { kind: "commit" } })).toBe(true);
    expect(needsProject({ action: { kind: "commit_capture" }, trigger: { kind: "manual" } })).toBe(true);
  });
  it("keeps an action of the same kind", () => {
    const a = { kind: "role" as const, role: "tester" as const, engine: "claude" as const, prompt: "x" };
    expect(actionOf("role", a)).toBe(a);
    expect(actionOf("workflow", a)).toEqual({ kind: "workflow", template: "review", goal: "" });
  });
  it("starts a role action on the engine it is given, Claude Code by default", () => {
    const from = { kind: "skill_upkeep" as const };
    expect(actionOf("role", from)).toEqual({ kind: "role", role: "reviewer", engine: "claude", prompt: "" });
    expect(actionOf("role", from, "codex")).toEqual({ kind: "role", role: "reviewer", engine: "codex", prompt: "" });
    expect(blankAutomation(null, null).action).toMatchObject({ engine: "claude" });
    expect(blankAutomation(null, null, "codex").action).toMatchObject({ engine: "codex" });
  });
});
