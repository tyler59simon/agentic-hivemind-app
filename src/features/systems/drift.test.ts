import { describe, expect, it } from "vitest";
import { changeCounts, changeText, findingText } from "./drift";

describe("drift words", () => {
  it("names changes by kind and section", () => {
    expect(changeText({ section: "elements", id: "api", kind: "changed", name: "API" })).toBe("Changed element API");
    expect(changeText({ section: "relationships", id: "a->b", kind: "removed", name: null })).toBe("Removed relationship a->b");
  });
  it("counts changes", () => {
    const c = (kind: string) => ({ section: "elements", id: kind, kind, name: null });
    expect(changeCounts([c("added"), c("removed"), c("added")])).toBe("2 added, 1 removed");
    expect(changeCounts([])).toBe("no changes");
  });
  it("says which rule a flow breaks", () => {
    expect(findingText({ rule: "r1", source: "worker", destination: "db", severity: "error", existing: true })).toBe("worker → db breaks r1 (error, accepted earlier)");
  });
});
