import { describe, expect, it } from "vitest";
import type { Recap } from "../../lib/lm";
import { LmError } from "../../lib/lm";
import { changeGroups, harnessLine, isQuiet, isUnbound, repeatLabel } from "./recap";

const change = (ref: string, count = 1) => ({ ref, title: ref, type: "bug", summary: "s", actor: "command", time: "2026-11-10T10:00:00Z", count });

describe("recap helpers", () => {
  it("orders non-empty groups and sums their counts", () => {
    const groups = changeGroups({ changes: { archived: [change("d:a")], created: [change("d:b", 2), change("d:c")], updated: [] } });
    expect(groups.map((g) => g.group)).toEqual(["created", "archived"]);
    expect(groups[0].total).toBe(3);
    expect(groups[0].items).toHaveLength(2);
  });
  it("lists harnesses by session count", () => {
    expect(harnessLine({ codex: 2, claude: 4 })).toBe("Claude 4, Codex 2");
    expect(harnessLine({})).toBe("");
  });
  it("recognises the unbound-project error Living Memory sends", () => {
    expect(isUnbound(new LmError("invalid", "unbound_project: no memory domain is bound to this folder", 2))).toBe(true);
    expect(isUnbound(new LmError("unbound_project", "no domain", 2))).toBe(true);
    expect(isUnbound(new LmError("invalid", "unknown note", 2))).toBe(false);
    expect(isUnbound(null)).toBe(false);
  });
  it("labels repeats only above one", () => {
    expect(repeatLabel(1)).toBe("");
    expect(repeatLabel(3)).toBe("3 times");
  });
  it("detects an empty recap", () => {
    const empty = { changes: {}, maintenance: { runs: 0 }, sessions: { count: 0 }, open_work: { notes: 0 }, review: { due: 0 } } as unknown as Recap;
    expect(isQuiet(empty)).toBe(true);
    expect(isQuiet({ ...empty, sessions: { count: 1 } } as unknown as Recap)).toBe(false);
  });
});
