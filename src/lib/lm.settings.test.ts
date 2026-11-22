// NS-7A: a Living Memory notebook's settings go to `doc notebook update` as a staged `--settings-file` (the bridge stages the
// JSON as it stages a page body), and a row of `doc notebooks` carries them back.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { docNotebooks, docNotebookUpdate, setTransport, type Invoke } from "./lm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("no Rust in this test"); }) }));
afterEach(() => setTransport(invoke as Invoke));

describe("notebook settings", () => {
  it("are sent as a settings file through lm_body, before the operands", async () => {
    const sent: { cmd: string; args: Record<string, unknown> }[] = [];
    setTransport(async (cmd, args) => { sent.push({ cmd, args }); return { exit_code: 0, error: null, result: { operation_id: "op" } }; });
    await docNotebookUpdate("demo", "daily", { settings: { daily: { folder: "Days", format: "YYYY-MM-DD" } } });
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe("lm_body");
    expect(sent[0].args).toMatchObject({
      argv: ["doc", "notebook", "update", "--include-private", "--", "demo", "daily"], body: '{"daily":{"folder":"Days","format":"YYYY-MM-DD"}}', flag: "--settings-file",
    });
  });

  it("go with a title or reach change in the same call, and a call without them sends no file", async () => {
    const sent: { cmd: string; args: Record<string, unknown> }[] = [];
    setTransport(async (cmd, args) => { sent.push({ cmd, args }); return { exit_code: 0, error: null, result: {} }; });
    await docNotebookUpdate("demo", "daily", { title: "Days", private: true, settings: { inbox: "In.md" } });
    expect(sent[0].args.argv).toEqual(["doc", "notebook", "update", "--title=Days", "--private", "--include-private", "--", "demo", "daily"]);
    await docNotebookUpdate("demo", "daily", { title: "Days" });
    expect(sent[1].cmd).toBe("lm");
    expect(sent[1].args).not.toHaveProperty("flag");
  });

  it("come back on the rows of the notebook list, and a Living Memory that sends none leaves them out", async () => {
    const row = { domain: "demo", notebook: "daily", title: "Daily", visibility: "searchable", private: false, revision: "r", pages: 1, assets: 0, asset_bytes: 0, proposals: 0, updated: "" };
    setTransport(async () => ({ exit_code: 0, error: null, result: { notebooks: [{ ...row, settings: { daily: { folder: "Days" } } }, { ...row, notebook: "old" }] } }));
    const { notebooks } = await docNotebooks();
    expect(notebooks[0].settings).toEqual({ daily: { folder: "Days" } });
    expect(notebooks[1].settings).toBeUndefined();
  });
});
