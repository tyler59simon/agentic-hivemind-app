import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LmError, addAction, changePlan, changesArgs, list, listArgs, openArgs, projectPlan, projects, projectsArgs, read, reviewArgs, run, searchArgs, setTransport, systemPlan, systemsArgs, timelineArgs, type Invoke } from "./lm";

afterEach(() => setTransport(invoke as Invoke));

function fake(reply: unknown) {
  const calls: unknown[] = [];
  setTransport(async (cmd, args) => { calls.push([cmd, args]); return reply; });
  return calls;
}

describe("argv builders", () => {
  it("list runs as viewer with filters", () => {
    expect(listArgs({ domain: "demo", status: "any", types: ["bug"], tags: ["concern/bug"], offset: 5, limit: 10 }))
      .toEqual(["list", "--domain", "demo", "--status", "any", "--type", "bug", "--tag", "concern/bug", "--offset", "5", "--limit", "10", "--actor", "viewer"]);
    expect(listArgs({ allDomains: true, domain: "ignored" })).toEqual(["list", "--all-domains", "--limit", "1000", "--actor", "viewer"]);
  });

  it("search adds --rebuild only when filtered", () => {
    const plain = searchArgs({ query: "cache", domain: "demo" });
    expect(plain).toEqual(["search", "cache", "--domain", "demo", "--scope", "fallback", "--limit", "30", "--actor", "viewer"]);
    const filtered = searchArgs({ query: "cache", domain: "demo", type: "bug", tag: "concern/bug" });
    expect(filtered).toContain("--rebuild");
    expect(filtered.join(" ")).toContain("--filter type=bug --filter tag=concern/bug");
  });
});

describe("run", () => {
  it("returns the result and sends argv to the bridge", async () => {
    const calls = fake({ exit_code: 0, result: { total: 0, notes: [] }, error: null });
    await expect(list({ domain: "demo" })).resolves.toEqual({ total: 0, notes: [] });
    expect(calls[0]).toEqual(["lm", { argv: listArgs({ domain: "demo" }), stdin: null }]);
  });

  it("read asks for the most text and stays read-only", async () => {
    const calls = fake({ exit_code: 0, result: {}, error: null });
    await read("demo:abc");
    expect((calls[0] as [string, { argv: string[] }])[1].argv).toEqual(["read", "demo:abc", "--max-chars", "64000", "--actor", "viewer"]);
  });

  it("throws LmError and flags stale revisions", async () => {
    fake({ exit_code: 6, result: null, error: { code: "stale", message: "Stale revision" } });
    const error = (await run(["update", "x"]).catch((e) => e)) as LmError;
    expect(error).toBeInstanceOf(LmError);
    expect(error.stale).toBe(true);
    expect(error.message).toBe("Stale revision");
  });

  it("list can ask for summaries", () => {
    expect(listArgs({ domain: "d", summary: true })).toEqual(["list", "--domain", "d", "--limit", "1000", "--with-summary", "--actor", "viewer"]);
  });

  it("projects, open, review and timeline read as viewer", () => {
    expect(projectsArgs()).toEqual(["projects", "--actor", "viewer"]);
    expect(projectsArgs({ status: "any" })).toEqual(["projects", "--status", "any", "--actor", "viewer"]);
    expect(openArgs({ domain: "d", tags: ["project/a", "concern/x"], limit: 5 }))
      .toEqual(["open", "--domain", "d", "--tag", "project/a", "--tag", "concern/x", "--limit", "5", "--actor", "viewer"]);
    expect(openArgs({ allDomains: true, domain: "ignored" })).toEqual(["open", "--all-domains", "--actor", "viewer"]);
    expect(reviewArgs({ allDomains: true, tags: ["project/a"] })).toEqual(["review", "--all-domains", "--tag", "project/a", "--actor", "viewer"]);
    expect(reviewArgs({ domain: "d" })).toEqual(["review", "--domain", "d", "--actor", "viewer"]);
    expect(timelineArgs({ ref: "d:abc", domain: "d", date: "2026-01-02", before: 3, after: 0, type: "bug", by: "created", all: true }))
      .toEqual(["timeline", "d:abc", "--domain", "d", "--date", "2026-01-02", "--before", "3", "--after", "0", "--type", "bug", "--by", "created", "--all", "--actor", "viewer"]);
    expect(timelineArgs({})).toEqual(["timeline", "--actor", "viewer"]);
  });

  it("project-plan is a write: stdin payload, no viewer flag", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await projectPlan("archive", { slug: "hive" });
    expect(calls[0]).toEqual(["lm", { argv: ["project-plan", "archive"], stdin: JSON.stringify({ slug: "hive" }) }]);
    const read = fake({ exit_code: 0, result: { ok: true, projects: [], warnings: [] }, error: null });
    await projects({ status: "active" });
    expect((read[0] as [string, { argv: string[] }])[1].argv).toEqual(["projects", "--status", "active", "--actor", "viewer"]);
  });

  it("system-plan is a write and systems is a viewer read", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await systemPlan("retire", { slug: "billing" });
    expect(calls[0]).toEqual(["lm", { argv: ["system-plan", "retire"], stdin: JSON.stringify({ slug: "billing" }) }]);
    expect(systemsArgs({ status: "active" })).toEqual(["systems", "--status", "active", "--actor", "viewer"]);
    expect(systemsArgs()).toEqual(["systems", "--actor", "viewer"]);
  });

  it("changes read as viewer and change plans carry the payload", async () => {
    expect(changesArgs()).toEqual(["changes", "--actor", "viewer"]);
    expect(changesArgs({ status: "active", project: "paystream" })).toEqual(["changes", "--status", "active", "--project", "paystream", "--actor", "viewer"]);
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await changePlan("update", { id: 14, stage: "design" });
    expect(calls[0]).toEqual(["lm", { argv: ["change-plan", "update"], stdin: '{"id":14,"stage":"design"}' }]);
    await addAction("demo:abc", "Ship it");
    expect(calls[1]).toEqual(["lm", { argv: ["update", "demo:abc", "--domain", "demo", "--add-action", "Ship it"], stdin: null }]);
  });
});
