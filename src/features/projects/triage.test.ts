import { describe, expect, it } from "vitest";
import { LmError } from "../../lib/lm";
import type { DomainInfo, LinkGraph, NoteRow, Project } from "../../lib/lm";
import { assignToProject, dismiss, dismissed, isUnder, resolveNoteFile, suggestTriage, withProjectTag } from "./triage";

const SB = "C:/Users/tyler/Documents/Sandbox";
const domains: DomainInfo[] = [
  { name: "sandbox", bound: true, prefixes: ["C:\\Users\\tyler\\Documents\\Sandbox"], active: 0, archived: 0 },
  { name: "agentic-living-memory", bound: true, prefixes: ["C:\\Users\\tyler\\Documents\\Sandbox\\agentic-living-memory"], active: 0, archived: 0 },
  { name: "_global", bound: false, prefixes: [], active: 0, archived: 0 },
];
const proj = (o: Partial<Project>): Project => ({
  slug: "x", name: "X", status: "active", repos: [], aliases: [], description: "", charter: null,
  created: "", updated: "", tag: "project/x", tag_registered: true, ...o,
});
const hivemind = proj({ slug: "hivemind", name: "Hivemind", tag: "project/hivemind", repos: [`${SB}/agentic-hivemind`] });
const lm = proj({ slug: "living-memory", name: "Living Memory", aliases: ["LM"], tag: "project/living-memory", repos: [`${SB}/agentic-living-memory`] });

let n = 0;
const row = (o: Partial<NoteRow>): NoteRow => ({
  ref: `sandbox:n${++n}`, id: `n${n}`, domain: "_global", title: "Unrelated", type: "knowledge", status: "active",
  tags: [], created: "2026-01-01", updated: "2026-01-01", revision: "r1", path: "", ...o,
});
const score = (p: Project, r: NoteRow, extra: Partial<Parameters<typeof suggestTriage>[0]> = {}) =>
  suggestTriage({ project: p, rows: [r], domains, ...extra })[0];

describe("path helpers", () => {
  it("is segment aware, slash and case insensitive", () => {
    expect(isUnder("C:/a/hive/x.ts", "C:/a/hive")).toBe(true);
    expect(isUnder("C:/a/hivemind/x.ts", "C:/a/hive")).toBe(false);
    expect(isUnder("c:\\A\\Hive\\src/x.ts", "C:/a/hive/")).toBe(true);
    expect(isUnder("C:/a/hive", "C:/a/hive")).toBe(true);
  });
  it("resolves relative entries against each prefix", () => {
    expect(resolveNoteFile("src/a.ts", ["C:\\p", "D:\\q\\"])).toEqual(["C:\\p/src/a.ts", "D:\\q/src/a.ts"]);
    expect(resolveNoteFile("C:\\abs\\a.ts", ["C:\\p"])).toEqual(["C:\\abs\\a.ts"]);
    expect(resolveNoteFile("./a.ts", [])).toEqual([]);
  });
});

describe("signals", () => {
  it("files: absolute, mixed slashes, and relative via domain prefixes", () => {
    expect(score(hivemind, row({ files: ["c:\\users\\TYLER/documents/sandbox\\agentic-hivemind\\src\\a.ts"] })).score).toBe(3);
    expect(score(hivemind, row({ domain: "sandbox", files: ["agentic-hivemind/src/lib/lm.ts"] })).reasons[0]).toBe("Files under agentic-hivemind");
    expect(score(hivemind, row({ domain: "sandbox", files: ["agentic-hivemind-old/a.ts"] }))).toBeUndefined();
    expect(score(hivemind, row({ domain: "_global", files: ["agentic-hivemind/a.ts"] }))).toBeUndefined();
  });
  it("domain: all prefixes under a repo", () => {
    const s = score(lm, row({ domain: "agentic-living-memory", title: "Some note" }));
    expect(s.score).toBe(3);
    expect(s.level).toBe("likely");
    expect(score(lm, row({ domain: "sandbox" }))).toBeUndefined();
  });
  it("title prefix", () => {
    for (const t of ["Hivemind: how to test", "Hivemind (agentic-hivemind): v1 roadmap", "hivemind - x", "Hivemind's design", "Hivemind"]) {
      expect(score(hivemind, row({ title: t }))?.score, t).toBe(3);
    }
    expect(score(hivemind, row({ title: "Hivemindset" }))).toBeUndefined();
    expect(score(lm, row({ title: "Living Memory roadmap: next" })).score).toBe(3);
    expect(score(lm, row({ title: "Living Memory: edit the source repo" })).score).toBe(3);
    expect(score(lm, row({ title: "LM notes" })).score).toBe(3);
    const asp = proj({ slug: "asp", name: "architecture-suite-plugin" });
    expect(score(asp, row({ title: "architecture-suite-plugin CI: fixes" })).score).toBe(3);
  });
  it("summary: whole word, not double counted with title", () => {
    expect(score(hivemind, row({ summary: "We use hivemind daily" }))).toMatchObject({ score: 1, level: "maybe" });
    expect(score(hivemind, row({ summary: "Hivemindset thing" }))).toBeUndefined();
    expect(score(lm, row({ summary: "uses LM here" })).score).toBe(1);
    expect(score(hivemind, row({ title: "Hivemind: x", summary: "Hivemind is great" })).score).toBe(3);
  });
  it("search hit", () => {
    expect(score(hivemind, row({ ref: "a:1" }), { hits: new Set(["a:1"]) })).toMatchObject({ score: 1 });
  });
  it("link neighbours both directions, capped at +2", () => {
    const node = (ref: string, tags: string[]) => ({ ref, id: ref, domain: "d", title: ref, type: "knowledge" as const, status: "active" as const, tags });
    const graph: LinkGraph = {
      domains: [], unresolved: [],
      nodes: [node("t1", [hivemind.tag]), node("t2", [hivemind.tag]), node("t3", [hivemind.tag]), node("o", [])],
      edges: [{ from: "x", to: "t1", kind: "link" }, { from: "t2", to: "x", kind: "link" }, { from: "x", to: "t3", kind: "link" }, { from: "x", to: "o", kind: "link" }],
    };
    expect(score(hivemind, row({ ref: "x" }), { graph }).score).toBe(2);
    const one = { ...graph, edges: [graph.edges[0]] };
    expect(score(hivemind, row({ ref: "x" }), { graph: one }).score).toBe(1);
  });
});

describe("filtering and ordering", () => {
  it("excludes tagged, archived and superseded; keeps resolved", () => {
    const rows = [
      row({ title: "Hivemind: a", tags: [hivemind.tag] }),
      row({ title: "Hivemind: b", status: "archived" }),
      row({ title: "Hivemind: c", status: "superseded" }),
      row({ title: "Hivemind: d", status: "resolved" }),
    ];
    expect(suggestTriage({ project: hivemind, rows, domains }).map((s) => s.title)).toEqual(["Hivemind: d"]);
  });
  it("reports other projects, levels and sorts by score then title", () => {
    const rows = [
      row({ title: "B note", summary: "hivemind", tags: ["project/living-memory", "ui"] }),
      row({ title: "Hivemind: z" }),
      row({ title: "Hivemind: a" }),
      row({ title: "A note", summary: "hivemind" }),
      row({ title: "none" }),
    ];
    const out = suggestTriage({ project: hivemind, rows, domains });
    expect(out.map((s) => s.title)).toEqual(["Hivemind: a", "Hivemind: z", "A note", "B note"]);
    expect(out.map((s) => s.level)).toEqual(["likely", "likely", "maybe", "maybe"]);
    expect(out[3].otherProjects).toEqual(["living-memory"]);
    expect(out[0].otherProjects).toEqual([]);
  });
});

describe("withProjectTag", () => {
  it("sorts and dedupes", () => {
    expect(withProjectTag(["z", "project/x", "a"], "project/x")).toEqual(["a", "project/x", "z"]);
  });
});

describe("assignToProject", () => {
  const rows = [{ ref: "d:1", title: "One", tags: ["b"], revision: "r1" }];
  const stale = () => new LmError("stale_revision", "stale_revision: changed", 6);
  it("succeeds", async () => {
    const calls: unknown[] = [];
    const res = await assignToProject(rows, "project/x", {
      update: async (ref, p) => { calls.push([ref, p]); return { operation_id: "op1" }; },
      meta: async () => { throw new Error("unused"); },
    });
    expect(res).toEqual([{ ref: "d:1", ok: true, operation_id: "op1" }]);
    expect(calls).toEqual([["d:1", { tags: ["b", "project/x"], expected_revision: "r1" }]]);
  });
  it("retries once on a stale revision using fresh tags", async () => {
    const seen: unknown[] = [];
    const res = await assignToProject(rows, "project/x", {
      update: async (_r, p) => { seen.push(p); if (seen.length === 1) throw stale(); return { operation_id: "op2" }; },
      meta: async () => ({ tags: ["b", "c"], revision: "r2" }),
    });
    expect(res[0]).toEqual({ ref: "d:1", ok: true, operation_id: "op2" });
    expect(seen[1]).toEqual({ tags: ["b", "c", "project/x"], expected_revision: "r2" });
  });
  it("reports a second stale failure", async () => {
    let calls = 0;
    const res = await assignToProject(rows, "project/x", {
      update: async () => { calls++; throw stale(); },
      meta: async () => ({ tags: [], revision: "r2" }),
    });
    expect(calls).toBe(2);
    expect(res[0]).toMatchObject({ ref: "d:1", ok: false });
  });
  it("reports other errors without retrying, and continues", async () => {
    let calls = 0;
    const res = await assignToProject([...rows, { ref: "d:2", title: "Two", tags: [], revision: "r" }], "project/x", {
      update: async (ref) => { calls++; if (ref === "d:1") throw new LmError("x", "Unknown tags require an approved taxonomy plan: project/x", 2); return {}; },
      meta: async () => { throw new Error("unused"); },
    });
    expect(calls).toBe(2);
    expect(res[0]).toEqual({ ref: "d:1", ok: false, error: "Unknown tags require an approved taxonomy plan: project/x" });
    expect(res[1]).toEqual({ ref: "d:2", ok: true, operation_id: undefined });
  });
});

describe("dismissed", () => {
  it("does not crash without localStorage", () => {
    expect(dismissed("hivemind").size).toBe(0);
    expect(() => dismiss("hivemind", "a:1")).not.toThrow();
  });
  it("persists when storage exists", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
    };
    try {
      dismiss("hivemind", "a:1"); dismiss("hivemind", "a:2");
      expect([...dismissed("hivemind")]).toEqual(["a:1", "a:2"]);
      expect(store.has("hivemind.triage.dismissed.hivemind")).toBe(true);
    } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
  });
});
