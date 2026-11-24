// Settings > Schedules helpers (CON-20; the task-graph helpers went with Workflows).
import { describe, expect, it } from "vitest";
import { ACTION_HELP, ACTION_LABELS, actionOf, blankAutomation, builtIn, clock, minutesOf, needsProject, nextText, scoped, triggerOf } from "./schedules";

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
    const brief = { ...blankAutomation(null, null), action: { kind: "executive_briefing" as const, briefing: "weekly" as const, days: 7 }, project: "pay", repo: "C:/r" };
    expect([scoped(brief).project, scoped(brief).repo]).toEqual(["pay", null]);
    expect(scoped({ ...brief, action: { kind: "memory_maintenance" } }).project).toBeNull();
    expect(needsProject({ action: { kind: "commit_capture" }, trigger: { kind: "manual" } })).toBe(true);
  });
  // CON-14: the Rebuild weekly switch on a project's wiki makes this action; the editor shows and edits it without losing its fields.
  it("keeps a wiki rebuild's domain and project through scoping and editing", () => {
    const rebuild = {
      ...blankAutomation("core", null), name: "Weekly wiki rebuild", trigger: { kind: "weekly" as const, days: [6], at: 180 },
      action: { kind: "wiki_rebuild" as const, domain: "demo" }, budgetUsd: 2,
    };
    expect(needsProject(rebuild)).toBe(false);
    expect(scoped(rebuild)).toEqual(rebuild);
    expect(scoped({ ...rebuild, repo: "C:/r" }).repo).toBeNull();
    const edited = scoped({ ...rebuild, enabled: false, trigger: { kind: "weekly", days: [5, 6], at: 240 }, budgetUsd: 1.5 });
    expect(edited).toMatchObject({ project: "core", action: { kind: "wiki_rebuild", domain: "demo" }, budgetUsd: 1.5, trigger: { days: [5, 6], at: 240 } });
    expect(actionOf("wiki_rebuild", rebuild.action)).toBe(rebuild.action);
    expect(actionOf("wiki_rebuild", { kind: "skill_upkeep" })).toEqual({ kind: "wiki_rebuild", domain: "" });
    expect(ACTION_LABELS.wiki_rebuild).toMatch(/agent wiki/);
    expect(ACTION_HELP.wiki_rebuild).toBeTruthy();
  });
  it("keeps an action of the same kind", () => {
    const a = { kind: "role" as const, role: "tester" as const, engine: "claude" as const, prompt: "x" };
    expect(actionOf("role", a)).toBe(a);
    expect(actionOf("skill_upkeep", a)).toEqual({ kind: "skill_upkeep" });
  });
  it("starts a role action on the engine it is given, Claude Code by default", () => {
    const from = { kind: "skill_upkeep" as const };
    expect(actionOf("role", from)).toEqual({ kind: "role", role: "reviewer", engine: "claude", prompt: "" });
    expect(actionOf("role", from, "codex")).toEqual({ kind: "role", role: "reviewer", engine: "codex", prompt: "" });
    expect(blankAutomation(null, null).action).toMatchObject({ engine: "claude" });
    expect(blankAutomation(null, null, "codex").action).toMatchObject({ engine: "codex" });
  });
});

describe("built-in schedules", () => {
  it("are the briefings, memory maintenance and wiki rebuilds; everything else is custom", () => {
    expect(builtIn({ action: { kind: "executive_briefing", briefing: "priorities", days: 1 } })).toBe(true);
    expect(builtIn({ action: { kind: "memory_maintenance" } })).toBe(true);
    expect(builtIn({ action: { kind: "wiki_rebuild", domain: "d" } })).toBe(true);
    expect(builtIn({ action: { kind: "skill_upkeep" } })).toBe(false);
    expect(builtIn({ action: { kind: "role", role: "reviewer", engine: "claude", prompt: "p" } })).toBe(false);
  });
});
