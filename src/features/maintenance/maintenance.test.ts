import { describe, expect, it } from "vitest";
import type { MaintenanceDecision, MaintenanceRun } from "../../lib/lm";
import {
  appliedDecisions, costText, deferredNotes, nextRunText, pruneSeen, reasonText, resultText, runCounts, runsWithin, runSummary, skipReasonText, sortDecisions, usd, wasArchived,
  type RunDecisions,
} from "./maintenance";
import { useSeen } from "./seen";

const run: MaintenanceRun = {
  id: "r1", status: "completed", day: "2026-11-16", attempted_at: "2026-11-16T23:26:21Z", finished_at: null, reason_code: null, model: "sonnet",
  reviewed: 10, charged_usd: "0.072669", cost_complete: true, updated: 0, confirmed: 0, archived: 2, superseded: 0, resolved: 0, kept: 1, deferred: 7, skipped: 0, distinct: 0,
};
const dec = (result: string, action = result): MaintenanceDecision => ({ ref: `d:${result}`, action, result, reason_code: null, operation_id: null, rule: null, reason: null });

describe("maintenance helpers", () => {
  it("explains skip reasons in words", () => {
    expect(skipReasonText("interval")).toMatch(/minimum interval/);
    expect(skipReasonText("daily_note_limit")).toBe("Today's note limit is reached.");
    expect(skipReasonText("daily_budget")).toBe("Today's budget is used up.");
    expect(skipReasonText(null)).toBe("");
    expect(skipReasonText("weird_thing")).toBe("Weird thing.");
  });
  it("says when the next run is", () => {
    const base = { enabled: true, running: false, eligible: false, blocked: null, skip_reason: "interval", next_eligible_at: "2030-01-01T00:00:00Z" };
    expect(nextRunText(base, new Date("2029-01-01"))).toMatch(/^Next run after .*minimum interval/);
    expect(nextRunText({ ...base, enabled: false })).toMatch(/^Off/);
    expect(nextRunText({ ...base, eligible: true })).toMatch(/due/);
    expect(nextRunText({ ...base, blocked: { reason: "provider_budget" } })).toBe("Blocked: provider budget.");
  });
  it("formats money", () => {
    expect(usd("0.072669")).toBe("$0.073");
    expect(usd("1.00")).toBe("$1.00");
    expect(usd("x")).toBe("");
    expect(costText("0.50", false)).toBe("$0.500 (incomplete)");
  });
  it("lists non-zero counts and always the reviewed count", () => {
    expect(runCounts(run).map((c) => c.label)).toEqual(["reviewed", "kept", "deferred", "archived"]);
    expect(runSummary(run)).toBe("10 reviewed, 1 kept, 7 deferred, 2 archived");
    expect(runSummary({ ...run, reviewed: 0, kept: 0, deferred: 0, archived: 0 })).toBe("0 reviewed");
  });
  it("words results and spots archived notes", () => {
    expect(resultText(dec("deferred", "defer"))).toBe("Deferred for later");
    expect(resultText(dec("applied", "archive"))).toBe("Archived");
    expect(resultText(dec("already_applied", "confirm"))).toBe("Confirmed still true");
    expect(resultText(dec("rejected", "archive"))).toBe("Refused by policy");
    expect(wasArchived(dec("applied", "archive"))).toBe(true);
    expect(wasArchived(dec("rejected", "archive"))).toBe(false);
    expect(wasArchived(dec("applied", "update"))).toBe(false);
  });
  it("puts acted-on decisions before kept and deferred ones", () => {
    const order = sortDecisions([dec("deferred", "defer"), dec("kept", "keep"), dec("applied", "archive"), dec("applied", "update")]);
    expect(order.map((d) => d.action)).toEqual(["archive", "update", "defer", "keep"]);
  });
});

// CON-6, CON-7: what the Inbox takes from maintenance runs.
describe("maintenance in the Inbox", () => {
  const NOW = Date.parse("2026-11-22T12:00:00Z");
  const DAY = 86_400_000;
  const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
  const made = (id: string, daysAgo: number, decisions: Partial<MaintenanceDecision>[], over: Partial<MaintenanceRun> = {}): RunDecisions => ({
    run: { ...run, id, attempted_at: at(daysAgo), ...over },
    decisions: decisions.map((d, i) => ({ ref: `d:n${i}`, action: "keep", result: "kept", reason_code: null, operation_id: null, rule: null, reason: null, ...d })),
  });

  it("reads only runs that reviewed notes, inside the window", () => {
    const runs = [made("a", 1, []).run, made("b", 40, []).run, made("c", 2, [], { reviewed: 0 }).run];
    expect(runsWithin(runs, NOW, 30).map((r) => r.id)).toEqual(["a"]);
    expect(runsWithin(runs, NOW, 60).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("lists a note whose latest decision in 30 days was a defer or a refusal, with the decision", () => {
    const done = [
      made("old", 20, [{ ref: "d:x", action: "defer", result: "deferred", reason: "Needs an owner" }, { ref: "d:y", action: "defer", result: "deferred" }]),
      made("new", 3, [{ ref: "d:y", action: "keep", result: "kept" }, { ref: "d:z", action: "archive", result: "rejected", rule: "pinned" }]),
      made("ancient", 45, [{ ref: "d:w", action: "defer", result: "deferred" }]),
    ];
    const deferred = deferredNotes(done, NOW);
    expect([...deferred.keys()].sort()).toEqual(["d:x", "d:z"]);
    expect(deferred.get("d:x")?.reason).toBe("Needs an owner");
    expect(deferredNotes([], NOW).size).toBe(0);
  });

  it("uses the later run whichever order the runs come in", () => {
    const later = made("later", 1, [{ ref: "d:x", result: "deferred", action: "defer" }]);
    const earlier = made("earlier", 5, [{ ref: "d:x", result: "applied", action: "update", operation_id: "op1" }]);
    expect([...deferredNotes([earlier, later], NOW).keys()]).toEqual(["d:x"]);
    expect([...deferredNotes([later, earlier], NOW).keys()]).toEqual(["d:x"]);
    expect(deferredNotes([made("later", 1, [{ ref: "d:x", result: "kept" }]), earlier], NOW).size).toBe(0);
  });

  it("words why a note was not decided", () => {
    expect(reasonText({ rule: "r3", reason: "Two sources disagree", reason_code: "conflict" })).toBe("r3: Two sources disagree");
    expect(reasonText({ rule: null, reason: "Too old", reason_code: null })).toBe("Too old");
    expect(reasonText({ rule: null, reason: null, reason_code: "needs_human" })).toBe("Needs human");
    expect(reasonText({ rule: null, reason: null, reason_code: null })).toBe("");
  });

  it("lists applied changes of the last 7 days that can be undone, newest first, without the ones marked", () => {
    const done = [
      made("a", 6, [
        { ref: "d:1", action: "archive", result: "applied", operation_id: "op-a1" },
        { ref: "d:2", action: "confirm", result: "applied", operation_id: "op-a2" },
        { ref: "d:3", action: "update", result: "already_applied", operation_id: "op-a3" },
        { ref: "d:4", action: "resolve", result: "applied", operation_id: null },
      ]),
      made("b", 1, [{ ref: "d:5", action: "supersede", result: "applied", operation_id: "op-b1" }, { ref: "d:6", action: "update", result: "applied", operation_id: "op-b2" }]),
      made("c", 9, [{ ref: "d:7", action: "archive", result: "applied", operation_id: "op-c1" }]),
    ];
    expect(appliedDecisions(done, NOW, {}).map((i) => i.key)).toEqual(["op-b1", "op-b2", "op-a1"]);
    const marked = appliedDecisions(done, NOW, { "op-b1": NOW - DAY });
    expect(marked.map((i) => i.key)).toEqual(["op-b2", "op-a1"]);
    expect(marked[0]).toMatchObject({ ref: "d:6", run: { id: "b" } });
  });

  it("forgets marked ids once their run is a week old", () => {
    expect(pruneSeen({ keep: NOW - 6 * DAY, drop: NOW - 8 * DAY }, NOW)).toEqual({ keep: NOW - 6 * DAY });
    expect(pruneSeen(undefined, NOW)).toEqual({});
  });

  it("remembers Looks right, and prunes what is too old when it saves", () => {
    useSeen.setState({ seen: { stale: Date.now() - 9 * DAY } });
    useSeen.getState().markSeen("op1", Date.now() - DAY);
    expect(Object.keys(useSeen.getState().seen)).toEqual(["op1"]);
    useSeen.setState({ seen: {} });
  });
});
