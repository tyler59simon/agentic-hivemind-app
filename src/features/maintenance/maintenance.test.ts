import { describe, expect, it } from "vitest";
import type { MaintenanceDecision, MaintenanceRun } from "../../lib/lm";
import { costText, nextRunText, resultText, runCounts, runSummary, skipReasonText, sortDecisions, usd, wasArchived } from "./maintenance";

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
