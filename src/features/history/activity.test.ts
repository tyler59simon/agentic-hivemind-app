import { describe, expect, it } from "vitest";
import type { Operation } from "../../lib/lm";
import { actorOf, dayLabel, domainOfOp, noteIdsOf, verbOf, visible } from "./activity";

const op = (kind: string, files: string[] = [], id = "op1", state = "committed"): Operation => ({ operation_id: id, kind, state, created: "2026-11-09T02:00:00+00:00", files });

describe("activity", () => {
  it("finds the notes an operation touched", () => {
    const o = op("archive", ["domains/demo/archive/KNOWLEDGE - cache-d0d301e8.md", "domains/demo/notes/KNOWLEDGE - cache-d0d301e8.md", "domains/demo/.derived-dirty"]);
    expect(noteIdsOf(o)).toEqual(["d0d301e8"]);
    expect(domainOfOp(o)).toBe("demo");
    expect(domainOfOp(op("taxonomy_expansion", ["tag_taxonomy.json"]))).toBeNull();
  });

  it("labels who acted", () => {
    const mine = new Set(["mine"]);
    expect(actorOf(op("update", [], "mine"), mine).label).toBe("You · Hivemind");
    expect(actorOf(op("overlay_auto_update"), mine).kind).toBe("obsidian");
    expect(actorOf(op("archive"), mine).label).toBe("Approved plan");
    expect(actorOf(op("undo:abc"), mine).kind).toBe("plan");
    expect(actorOf(op("capture"), mine, "claude:3f2a9c1b0d4e").label).toBe("Claude");
    expect(actorOf(op("capture"), mine, "codex:aa").label).toBe("Codex");
    expect(actorOf(op("capture"), mine, "hivemind:local").kind).toBe("you");
    expect(actorOf(op("capture"), mine).label).toBe("Agent or CLI");
    expect(actorOf(op("update"), mine, "claude:x").label).toBe("Agent or CLI"); // updates carry no origin
  });

  it("describes and filters operations", () => {
    expect(verbOf("overlay_capture")).toBe("captured in Obsidian");
    expect(verbOf("undo:123")).toBe("undid a change");
    expect(verbOf("something_new")).toBe("something new");
    expect(visible(op("overlay_state"))).toBe(false);
    expect(visible(op("update", [], "x", "rolled_back"))).toBe(false);
    expect(visible(op("update"))).toBe(true);
  });

  it("groups by local day", () => {
    const now = new Date("2026-11-09T12:00:00");
    expect(dayLabel(new Date("2026-11-09T08:00:00").toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date("2026-11-08T23:00:00").toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date("2026-11-01T08:00:00").toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });
});
