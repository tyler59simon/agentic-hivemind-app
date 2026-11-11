import { describe, expect, it } from "vitest";
import type { RunEvent, SeqEvent } from "../../lib/agent";
import { apply, build, cost, duration, EMPTY, lastTurn, latestFiles, merge, pendingApprovals } from "./events";

const at = (seq: number, event: RunEvent): SeqEvent => ({ sessionId: "s", seq, at: 0, event });
const finished: RunEvent = { type: "finished", status: "succeeded", reason: null, costUsd: 0.5, durationMs: 65000, turns: 4, result: "ok", structured: null, denials: 1 };
const turn = (outcome: "completed" | "stopped" = "completed"): RunEvent => ({
  type: "turnFinished", ok: outcome === "completed", reason: null, costUsd: 0.12, durationMs: 4000, result: "done", denials: 0, outcome,
});
const request = (requestId: string): RunEvent => ({ type: "approvalRequest", requestId, tool: "Edit", summary: "a.ts", input: { path: "a.ts" }, canAlways: true, alwaysLabel: "Edit files" });
const resolved = (requestId: string, decision: "allow" | "withdrawn"): RunEvent => ({ type: "approvalResolved", requestId, decision });
const files = (path: string): RunEvent => ({ type: "filesChanged", files: [{ path, status: "M", added: 1, removed: 0 }] });
const events: SeqEvent[] = [
  at(0, { type: "started", model: "m", cliVersion: "2.1", plugins: ["architecture-suite"] }),
  at(1, { type: "text", text: "Reading the repo." }),
  at(2, { type: "toolUse", id: "t1", name: "Read", summary: "README.md" }),
  at(3, { type: "toolResult", id: "t1", ok: true, summary: "# Billing" }),
  at(4, { type: "toolUse", id: "t2", name: "Bash", summary: "rm -rf x" }),
  at(5, { type: "denied", tool: "Bash", summary: "Permission to use Bash has been denied" }),
  at(6, { type: "toolResult", id: "t2", ok: false, summary: "denied" }),
  at(7, finished),
];

describe("transcript", () => {
  it("builds items in order and attaches results to their tool calls", () => {
    const t = build(events);
    expect(t.next).toBe(8);
    expect(t.items.map((i) => i.kind)).toEqual(["started", "text", "tool", "tool", "denied"]);
    expect(t.items[2]).toEqual({ kind: "tool", id: "t1", name: "Read", summary: "README.md", result: { ok: true, summary: "# Billing" } });
    expect(t.items[3]).toMatchObject({ id: "t2", result: { ok: false } });
    expect(t.finished).toEqual(finished);
    expect(t.gap).toBe(false);
  });

  it("ignores duplicates and flags a gap instead of applying out of order", () => {
    const some = build(events.slice(0, 3));
    expect(apply(some, events[1])).toBe(some);
    const ahead = apply(some, events[5]);
    expect(ahead.gap).toBe(true);
    expect(ahead.items).toHaveLength(3);
    expect(apply(ahead, events[6])).toBe(ahead);
  });

  it("shows the user's message and the turn end", () => {
    const t = build([
      at(0, { type: "userMessage", text: "Fix it", context: ["n1"] }), at(1, events[0].event), at(2, { type: "text", text: "Done." }), at(3, turn()),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "started", "text", "turn"]);
    expect(t.items[0]).toEqual({ kind: "user", text: "Fix it", context: ["n1"] });
    expect(t.items[3]).toMatchObject({ kind: "turn", ok: true, outcome: "completed", costUsd: 0.12, durationMs: 4000 });
  });

  it("an approval is open until it is resolved, and the first answer stands", () => {
    const asked = build([at(0, request("r1"))]);
    expect(pendingApprovals(asked)).toHaveLength(1);
    expect(asked.items[0]).toEqual({ kind: "approval", requestId: "r1", tool: "Edit", summary: "a.ts", input: { path: "a.ts" }, canAlways: true, alwaysLabel: "Edit files" });
    const answered = apply(asked, at(1, resolved("r1", "allow")));
    expect(pendingApprovals(answered)).toHaveLength(0);
    expect(answered.items[0]).toMatchObject({ decision: "allow" });
    const later = apply(answered, at(2, resolved("r1", "withdrawn")));
    expect(later.items[0]).toMatchObject({ decision: "allow" });
  });

  it("a turn end closes approvals that were never answered", () => {
    const open = [at(0, request("r1")), at(1, request("r2")), at(2, resolved("r2", "allow"))];
    const afterTurn = build([...open, at(3, turn())]);
    expect(afterTurn.items.filter((i) => i.kind === "approval").map((i) => i.kind === "approval" && i.decision)).toEqual(["withdrawn", "allow"]);
    expect(pendingApprovals(afterTurn)).toHaveLength(0);
    const afterFinish = build([...open, at(3, finished)]);
    expect(afterFinish.items.filter((i) => i.kind === "approval").map((i) => i.kind === "approval" && i.decision)).toEqual(["withdrawn", "allow"]);
    expect(afterFinish.finished).toEqual(finished);
  });

  it("the latest files and the last turn are found", () => {
    expect(latestFiles(EMPTY)).toBeUndefined();
    expect(lastTurn(EMPTY)).toBeUndefined();
    const t = build([at(0, files("a.ts")), at(1, turn()), at(2, files("b.ts")), at(3, turn("stopped"))]);
    expect(latestFiles(t)).toEqual([{ path: "b.ts", status: "M", added: 1, removed: 0 }]);
    expect(lastTurn(t)).toMatchObject({ kind: "turn", outcome: "stopped", ok: false });
  });

  it("a stored log plus live events equals the full stream", () => {
    const live = events.slice(4).reduce(apply, build(events.slice(0, 4)));
    expect(live).toEqual(build(events));
    const all = [
      at(0, { type: "userMessage", text: "Go", context: [] }), at(1, events[0].event), at(2, request("r1")), at(3, resolved("r1", "allow")), at(4, request("r2")),
      at(5, files("a.ts")), at(6, turn()), at(7, resolved("r2", "withdrawn")), at(8, finished),
    ];
    for (let split = 0; split <= all.length; split++) expect(all.slice(split).reduce(apply, build(all.slice(0, split)))).toEqual(build(all));
  });

  it("a fresh log replaces the live state unless the live state is further along", () => {
    const behind = { ...build(events.slice(0, 2)), gap: true };
    expect(merge(behind, build(events))).toEqual(build(events));
    const further = { ...build(events), gap: true };
    expect(merge(further, build(events.slice(0, 2)))).toEqual({ ...build(events), gap: false });
    expect(merge(EMPTY, EMPTY)).toEqual(EMPTY);
  });

  it("formats durations and cost", () => {
    expect(duration(42_400)).toBe("42 s");
    expect(duration(65_000)).toBe("1 min 5 s");
    expect(duration(null)).toBe("");
    expect(cost(0.456)).toBe("$0.46");
    expect(cost(null)).toBe("");
  });
});
