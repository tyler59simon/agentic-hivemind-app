import { describe, expect, it } from "vitest";
import type { LinkGraph, NoteRow, OpenItem, Project } from "../../lib/lm";
import { dashboardSections, openCountsByProject, progress, projectGraph, projectOps } from "./projects";

const row = (o: Partial<NoteRow> & { ref: string }): NoteRow => ({
  id: o.ref.split(":")[1] ?? "x", domain: "d", title: o.ref, type: "knowledge", status: "active", tags: ["project/x"],
  created: "2026-01-01", updated: "2026-01-01", revision: "r", path: "", ...o,
});

describe("dashboardSections", () => {
  const rows = [
    row({ ref: "d:charter", type: "context" }),
    row({ ref: "d:k1", type: "knowledge" }), row({ ref: "d:pol", type: "policy" }),
    row({ ref: "d:p1", type: "plan", updated: "2026-02-01" }), row({ ref: "d:p2", type: "plan", updated: "2026-03-01" }),
    row({ ref: "d:dec1", type: "decision", created: "2026-01-05" }), row({ ref: "d:dec2", type: "decision", created: "2026-02-05" }),
    row({ ref: "d:dec3", type: "decision", status: "superseded" }),
    row({ ref: "d:bug", type: "bug" }), row({ ref: "d:bugdone", type: "bug", status: "resolved" }), row({ ref: "d:risk", type: "risk" }),
    row({ ref: "d:s1", type: "status", updated: "2026-01-02" }), row({ ref: "d:s2", type: "status", updated: "2026-04-02" }),
    row({ ref: "d:old", type: "knowledge", status: "archived" }),
  ];
  const s = dashboardSections(rows, "d:charter");
  it("splits notes into sections", () => {
    expect(s.charter?.ref).toBe("d:charter");
    expect(s.roadmap.map((r) => r.ref)).toEqual(["d:p2", "d:p1"]);
    expect(s.decisions.map((r) => r.ref)).toEqual(["d:dec2", "d:dec1"]);
    expect(s.risks.map((r) => r.ref).slice(-1)).toEqual(["d:bugdone"]);
    expect(s.risks).toHaveLength(3);
    expect(s.knowledge.map((r) => r.ref).sort()).toEqual(["d:k1", "d:pol"]);
    expect(s.latestStatus?.ref).toBe("d:s2");
    expect(s.retired.map((r) => r.ref).sort()).toEqual(["d:dec3", "d:old"]);
  });
  it("copes without a charter", () => {
    expect(dashboardSections(rows, null).charter).toBeUndefined();
    expect(dashboardSections(rows, null).knowledge.map((r) => r.ref)).toContain("d:charter");
  });
});

describe("progress", () => {
  it("counts actions", () => {
    expect(progress({ actions: { open: 3, done: 1 } })).toEqual({ done: 1, total: 4, pct: 25 });
    expect(progress({})).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe("projectGraph", () => {
  const node = (ref: string) => ({ ref, id: ref, domain: "d", title: ref, type: "knowledge" as const, status: "active" as const, tags: [] });
  const g: LinkGraph = {
    domains: ["d"], nodes: ["a", "b", "c", "d"].map(node),
    edges: [{ from: "a", to: "b", kind: "link" }, { from: "b", to: "c", kind: "link" }, { from: "c", to: "d", kind: "link" }],
    unresolved: [],
  };
  it("keeps members and one hop", () => {
    const out = projectGraph(g, new Set(["a"]));
    expect(out.nodes.map((n) => n.ref)).toEqual(["a", "b"]);
    expect(out.edges).toHaveLength(1);
  });
});

describe("projectOps", () => {
  const op = (id: string, files: string[]) => ({ operation_id: id, kind: "update", state: "committed", created: "", files });
  it("matches by id prefix or projects.json", () => {
    const ops = [op("1", ["domains/d/knowledge/KNOWLEDGE - t-abcdef12.md"]), op("2", ["domains/d/knowledge/KNOWLEDGE - t-00000000.md"]), op("3", ["projects.json"])];
    expect(projectOps(ops, new Set(["abcdef12-3456-7890"])).map((o) => o.operation_id)).toEqual(["1", "3"]);
  });
});

describe("openCountsByProject", () => {
  it("joins items to project tags", () => {
    const projects = [{ slug: "x", tag: "project/x" }, { slug: "y", tag: "project/y" }] as Project[];
    const items = [{ ref: "d:a" }, { ref: "d:a" }, { ref: "d:b" }, { ref: "d:zz" }] as OpenItem[];
    const rows = [row({ ref: "d:a", tags: ["project/x"] }), row({ ref: "d:b", tags: ["project/y", "project/x"] })];
    expect([...openCountsByProject(items, rows, projects)]).toEqual([["x", 3], ["y", 1]]);
  });
});
