import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LmError, list, listArgs, read, run, searchArgs, setTransport, type Invoke } from "./lm";

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
});
