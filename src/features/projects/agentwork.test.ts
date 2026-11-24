import { describe, expect, it } from "vitest";
import { agentActivity, agentNeeds } from "./agentwork";

const NOW = 10 * 86_400_000;
const run = (state: string, at = NOW - 1000) => ({ id: state + at, automation: "a1", at, cause: "manual", event: null, state, detail: "did it", session: null, costUsd: null, endedAt: null }) as never;

describe("agentNeeds", () => {
  it("lists what waits for the user, with where to go", () => {
    const needs = agentNeeds({
      memoryDrafts: 2, skillDrafts: 1, runs: [run("waiting"), run("failed"), run("failed", NOW - 2 * 86_400_000)],
      drift: { system: "pay", attention: true, summary: "3 commits behind" } as never, stale: 4, duplicates: 1, now: NOW,
    });
    expect(needs.map((x) => x.text)).toEqual([
      "2 learned note drafts to approve or reject", "1 skill proposal to approve or reject", "1 automation run waiting for you to start", "1 automation run failed today",
      "Architecture drift: 3 commits behind", "4 stale notes and 1 possible duplicate in memory",
    ]);
    expect(needs[4].target).toEqual({ page: "architecture", system: "pay" });
    expect(needs[0].target).toEqual({ page: "inbox", kind: "memory" });
    expect(needs[1].target).toEqual({ page: "inbox", kind: "skills" });
    expect(needs[2].target).toEqual({ page: "schedules" });
    expect(needs[5].target).toEqual({ page: "inbox", kind: "memory" });
    const behindOnly = { system: "pay", attention: true, summary: "3 commits behind", edited: [], findings: null, layout: null } as never;
    const none = { memoryDrafts: 0, skillDrafts: 0, runs: [], now: NOW };
    expect(agentNeeds({ ...none, drift: behindOnly, behindShown: true })).toEqual([]);
    expect(agentNeeds({ ...none, drift: behindOnly })).toHaveLength(1);
  });
  it("sends skill drafts alone to the Inbox's Skills group", () => {
    const [need] = agentNeeds({ memoryDrafts: 0, skillDrafts: 2, runs: [], now: NOW });
    expect(need.target).toEqual({ page: "inbox", kind: "skills" });
  });
  it("is empty when nothing waits", () => {
    expect(agentNeeds({ memoryDrafts: 0, skillDrafts: 0, runs: [run("succeeded")], drift: { attention: false } as never, now: NOW })).toEqual([]);
  });
});

describe("agentActivity", () => {
  it("merges sessions, automation runs and skill changes, newest first", () => {
    const items = agentActivity({
      sessions: [{ id: "s1", endedAt: 30, status: "failed", name: null, title: "Fix it" }, { id: "s2", endedAt: null, status: "running", title: "x" }] as never,
      runs: [run("succeeded", 20)],
      ledger: [{ at: 50, actor: "user", action: "publish", name: "restart-recovery", version: 2, sha256: null, proposal: null, detail: null }],
      automationName: () => "Nightly maintenance",
    });
    expect(items.map((x) => x.text)).toEqual([
      "Skill restart-recovery: publish (version 2)", "Session failed: Fix it", "Nightly maintenance ran: did it",
    ]);
  });
});
