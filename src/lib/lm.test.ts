import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LmError, addAction, archiveNote, isPlan, supersedeNote, taxonomyAdd, undo, maintenanceDisable, maintenanceEnable, maintenanceHistory, maintenanceRun, maintenanceStatus, restoreNote, setPin, writeChange, changesArgs, list, listArgs, logArgs, openArgs, writeProject, projects, projectsArgs, read, recapArgs, reviewArgs, run, searchArgs, setDetail, setTransport, writeSystem, systemsArgs, timelineArgs, wikiModel, type Invoke } from "./lm";

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
    expect(reviewArgs({ allDomains: true, kind: ["stale", "duplicate"], limit: 50 }))
      .toEqual(["review", "--all-domains", "--kind", "stale", "--kind", "duplicate", "--limit", "50", "--actor", "viewer"]);
    expect(timelineArgs({ ref: "d:abc", domain: "d", date: "2026-01-02", before: 3, after: 0, type: "bug", by: "created", all: true }))
      .toEqual(["timeline", "d:abc", "--domain", "d", "--date", "2026-01-02", "--before", "3", "--after", "0", "--type", "bug", "--by", "created", "--all", "--actor", "viewer"]);
    expect(timelineArgs({})).toEqual(["timeline", "--actor", "viewer"]);
  });

  it("project is a direct write: stdin payload, no viewer flag", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await writeProject("archive", { slug: "hive" });
    expect(calls[0]).toEqual(["lm", { argv: ["project", "archive"], stdin: JSON.stringify({ slug: "hive" }) }]);
    const read = fake({ exit_code: 0, result: { ok: true, projects: [], warnings: [] }, error: null });
    await projects({ status: "active" });
    expect((read[0] as [string, { argv: string[] }])[1].argv).toEqual(["projects", "--status", "active", "--actor", "viewer"]);
  });

  it("system is a direct write and systems is a viewer read", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await writeSystem("retire", { slug: "billing" });
    expect(calls[0]).toEqual(["lm", { argv: ["system", "retire"], stdin: JSON.stringify({ slug: "billing" }) }]);
    expect(systemsArgs({ status: "active" })).toEqual(["systems", "--status", "active", "--actor", "viewer"]);
    expect(systemsArgs()).toEqual(["systems", "--actor", "viewer"]);
  });

  it("changes read as viewer and change writes carry the payload", async () => {
    expect(changesArgs()).toEqual(["changes", "--actor", "viewer"]);
    expect(changesArgs({ status: "active", project: "paystream" })).toEqual(["changes", "--status", "active", "--project", "paystream", "--actor", "viewer"]);
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await writeChange("update", { id: 14, stage: "design" });
    expect(calls[0]).toEqual(["lm", { argv: ["change", "update"], stdin: '{"id":14,"stage":"design"}' }]);
    await addAction("demo:abc", "Ship it");
    expect(calls[1]).toEqual(["lm", { argv: ["update", "demo:abc", "--domain", "demo", "--add-action", "Ship it"], stdin: null }]);
  });

  it("lifecycle and taxonomy writes are direct commands, and undo may return a plan", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true, operation_id: "d-1" }, error: null });
    await archiveNote("demo:abc");
    await supersedeNote("demo:abc", "xyz");
    await taxonomyAdd(["concern/security"]);
    expect(calls.map((c) => (c as [string, { argv: string[] }])[1].argv)).toEqual([
      ["archive", "demo:abc", "--domain", "demo"], ["supersede", "demo:abc", "--by", "xyz", "--domain", "demo"], ["taxonomy", "add", "concern/security"]]);
    expect(isPlan(await undo("op"))).toBe(false);
    fake({ exit_code: 0, result: { ok: true, plan_id: "p", digest: "d", kind: "undo", summary: {} }, error: null });
    expect(isPlan(await undo("op"))).toBe(true);
  });

  it("log reads as viewer and only sends the filters given", () => {
    expect(logArgs({})).toEqual(["log", "--actor", "viewer"]);
    expect(logArgs({ domain: "d", project: "hive", since: "2026-11-01", until: "2026-11-09", note: "CHG-014", type: "decision", event: "created", limit: 20 }))
      .toEqual(["log", "--domain", "d", "--project", "hive", "--since", "2026-11-01", "--until", "2026-11-09", "--note", "CHG-014", "--type", "decision", "--event", "created", "--limit", "20", "--actor", "viewer"]);
  });

  it("recap covers every domain, narrowed by project and days", () => {
    expect(recapArgs({})).toEqual(["recap", "--all-domains", "--actor", "viewer"]);
    expect(recapArgs({ days: 30, project: "hive" })).toEqual(["recap", "--all-domains", "--days", "30", "--project", "hive", "--actor", "viewer"]);
  });

  it("set-detail puts the revision in argv and sends no stdin", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await setDetail("demo:abc", "**Where it stands:** now", "rev1");
    await setDetail("demo:abc", "**Where it stands:** now");
    expect(calls[0]).toEqual(["lm", { argv: ["update", "demo:abc", "--domain", "demo", "--set-detail", "**Where it stands:** now", "--expected-revision", "rev1"], stdin: null }]);
    expect(calls[1]).toEqual(["lm", { argv: ["update", "demo:abc", "--domain", "demo", "--set-detail", "**Where it stands:** now"], stdin: null }]);
  });
});

describe("maintenance, restore and pin argv", () => {
  const argvOf = (calls: unknown[], i = 0) => (calls[i] as [string, { argv: string[] }])[1].argv;
  it("reads run as viewer", async () => {
    const calls = fake({ exit_code: 0, result: {}, error: null });
    await maintenanceStatus(); await maintenanceHistory(); await maintenanceHistory(5); await maintenanceRun("r1");
    expect(argvOf(calls, 0)).toEqual(["maintenance", "status", "--actor", "viewer"]);
    expect(argvOf(calls, 1)).toEqual(["maintenance", "history", "--actor", "viewer"]);
    expect(argvOf(calls, 2)).toEqual(["maintenance", "history", "--limit", "5", "--actor", "viewer"]);
    expect(argvOf(calls, 3)).toEqual(["maintenance", "history", "--run", "r1", "--actor", "viewer"]);
  });
  it("enable, disable, restore and pin are plain writes", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true }, error: null });
    await maintenanceEnable("demo"); await maintenanceEnable("other"); await maintenanceDisable();
    await restoreNote("demo:abc"); await setPin("demo:abc", true); await setPin("demo:abc", false);
    expect(argvOf(calls, 0)).toEqual(["maintenance", "enable", "--domain", "demo"]);
    expect(argvOf(calls, 1)).toEqual(["maintenance", "enable", "--domain", "other"]);
    expect(argvOf(calls, 2)).toEqual(["maintenance", "disable"]);
    expect(argvOf(calls, 3)).toEqual(["restore", "demo:abc", "--domain", "demo"]);
    expect(argvOf(calls, 4)).toEqual(["update", "demo:abc", "--domain", "demo", "--pin"]);
    expect(argvOf(calls, 5)).toEqual(["update", "demo:abc", "--domain", "demo", "--unpin"]);
  });
});

describe("wiki", () => {
  const argvOf = (calls: unknown[], i = 0) => (calls[i] as [string, { argv: string[] }])[1].argv;
  it("reads the model as viewer, and asks for retired notes only when told", async () => {
    const calls = fake({ exit_code: 0, result: { ok: true, model: { domain: "demo" } }, error: null });
    await expect(wikiModel("demo")).resolves.toEqual({ domain: "demo" });
    await wikiModel("demo", { archived: true });
    expect(argvOf(calls, 0)).toEqual(["wiki", "--format", "json", "--domain", "demo", "--actor", "viewer"]);
    expect(argvOf(calls, 1)).toEqual(["wiki", "--format", "json", "--domain", "demo", "--archived", "--actor", "viewer"]);
  });
});
