// Codex review of 7320d7f, DATA-1: Living Memory's read stops at 64,000 characters. A note read that way is never
// written back by the link rewrite after a rename, because the write replaces the whole body.
import { beforeEach, describe, expect, it, vi } from "vitest";

const notes = new Map<string, { body: string; revision: string; truncated: boolean }>();
const updates: { ref: string; payload: { body?: string; expected_revision?: string }; at?: number }[] = [];
let nowGeneration: number | undefined = 7;
vi.mock("../../lib/lm", () => ({
  read: vi.fn(async (ref: string) => notes.get(ref)),
  update: vi.fn(async (ref: string, payload: { body?: string }, opts: { at?: number } = {}) => { updates.push({ ref, payload, at: opts.at }); return { operation_id: "op-1" }; }),
  bridgeGeneration: () => nowGeneration,
}));
vi.mock("../../lib/oplog", () => ({ recordOperation: vi.fn() }));

const { rewriteIncoming } = await import("./rewriteIncoming");

beforeEach(() => { notes.clear(); updates.length = 0; nowGeneration = 7; });

describe("the link rewrite after a rename", () => {
  it("rewrites a note it read whole", async () => {
    notes.set("d:1", { body: "See [[Old]] here.", revision: "r1", truncated: false });
    const out = await rewriteIncoming([{ ref: "d:1", title: "One" }], "Old", "New");
    expect(out).toEqual({ done: 1, failed: [], skipped: [] });
    expect(updates).toEqual([{ ref: "d:1", payload: { body: "See [[New]] here.", expected_revision: "r1" }, at: 7 }]);
  });

  it("carries the bridge generation of the rename on every write, so a switch of store refuses it", async () => {
    notes.set("d:1", { body: "See [[Old]].", revision: "r1", truncated: false });
    notes.set("d:2", { body: "And [[Old]].", revision: "r2", truncated: false });
    // The editor passes the generation its note was read in; Hivemind has moved on to another store since.
    nowGeneration = 8;
    await rewriteIncoming([{ ref: "d:1", title: "One" }, { ref: "d:2", title: "Two" }], "Old", "New", 3);
    expect(updates.map((u) => u.at)).toEqual([3, 3]);
    // Without one, the generation when the rewrite starts is used, and held for the whole run.
    updates.length = 0;
    await rewriteIncoming([{ ref: "d:1", title: "One" }, { ref: "d:2", title: "Two" }], "Old", "New");
    expect(updates.map((u) => u.at)).toEqual([8, 8]);
  });

  it("does not write a note that was read cut off, and lists it as skipped", async () => {
    notes.set("d:1", { body: "See [[Old]] here.", revision: "r1", truncated: true });
    notes.set("d:2", { body: "No link in the part that was read.", revision: "r2", truncated: true });
    notes.set("d:3", { body: "Also [[Old]].", revision: "r3", truncated: false });
    const out = await rewriteIncoming([{ ref: "d:1", title: "One" }, { ref: "d:2", title: "Two" }, { ref: "d:3", title: "Three" }], "Old", "New");
    expect(updates.map((u) => u.ref)).toEqual(["d:3"]);
    expect(out).toEqual({ done: 1, failed: [], skipped: ["One", "Two"] });
  });
});
