import { describe, expect, it } from "vitest";
import type { NoteRow, ReviewRow } from "../../lib/lm";
import { agentCaptured, candidates, dueNotes, unconfirmed } from "./memory";

const now = new Date("2026-11-12T12:00:00Z");
const note = (over: Partial<NoteRow> = {}): NoteRow => ({
  ref: "d:a", id: "a", domain: "d", title: "A", type: "knowledge", status: "active", tags: [], created: "2026-11-09", updated: "2026-11-10", revision: "r1", path: "a.md", ...over,
});

describe("memory items", () => {
  it("candidates are recent active notes", () => {
    const rows = [note({ ref: "d:new" }), note({ ref: "d:old", created: "2026-10-23" }), note({ ref: "d:gone", status: "archived" })];
    expect(candidates(rows, now).map((r) => r.ref)).toEqual(["d:new"]);
    const many = Array.from({ length: 60 }, (_, i) => note({ ref: `d:${i}` }));
    expect(candidates(many, now)).toHaveLength(40);
  });

  it("an agent capture is unconfirmed until someone confirms it", () => {
    expect(agentCaptured({ status: "active", origin: "claude:0123456789ab" })).toBe(true);
    expect(agentCaptured({ status: "active", origin: "claude:0123456789ab", confirmed: [] })).toBe(true);
    expect(agentCaptured({ status: "active", origin: "claude:0123456789ab", confirmed: ["2026-11-09"] })).toBe(false);
    expect(agentCaptured({ status: "active", origin: "hivemind:local" })).toBe(false);
    expect(agentCaptured({ status: "active" })).toBe(false);
    expect(agentCaptured({ status: "archived", origin: "claude:0123456789ab" })).toBe(false);
  });

  it("unconfirmed leaves out due notes and unloaded metadata", () => {
    const rows = [note({ ref: "d:1", title: "One" }), note({ ref: "d:2" }), note({ ref: "d:3" })];
    const agent = { status: "active" as const, origin: "claude:0123456789ab" };
    expect(unconfirmed(rows, [agent, undefined, agent], new Set(["d:3"]))).toEqual([
      { ref: "d:1", title: "One", type: "knowledge", updated: "2026-11-10", revision: "r1", domain: "d" },
    ]);
  });

  // CON-7: a due note shows only when maintenance deferred it, while maintenance is on.
  it("lists every due note unless maintenance filters them", () => {
    const row = (ref: string): ReviewRow => ({ ref, title: ref, type: "knowledge", updated: "2026-11-01" });
    const rows = [row("d:a"), row("d:b"), row("d:c")];
    expect(dueNotes(rows, null)).toEqual(rows);
    expect(dueNotes(rows, new Map([["d:b", {}]]), ["d"]).map((r) => r.ref)).toEqual(["d:b"]);
    expect(dueNotes(rows, new Map(), ["d"])).toEqual([]);
  });

  it("keeps the due notes of a domain maintenance does not cover", () => {
    const row = (ref: string): ReviewRow => ({ ref, title: ref, type: "knowledge", updated: "2026-11-01" });
    const rows = [row("work:a"), row("work:b"), row("home:c")];
    expect(dueNotes(rows, new Map([["work:b", {}]]), ["work"]).map((r) => r.ref)).toEqual(["work:b", "home:c"]);
    expect(dueNotes(rows, null, ["work"])).toEqual(rows);
  });
});
