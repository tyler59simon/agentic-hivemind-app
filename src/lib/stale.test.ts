// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useToasts } from "../ui/toast";
import { LmError, setTransport } from "./lm";
import { STALE_MESSAGE, STALE_UNREAD, toastWriteFailure, writeFailure } from "./stale";

/** Whether `read REF --metadata-only` fails, and which refs it was asked for. */
const reads = { fail: false, refs: [] as string[] };
beforeEach(() => {
  Object.assign(reads, { fail: false, refs: [] });
  setTransport(async (_cmd, args) => {
    const argv = (args as { argv: string[] }).argv;
    if (argv[0] !== "read") return { exit_code: 1, result: null, error: { code: "invalid", message: "not in this test" } };
    reads.refs.push(argv[1]);
    if (reads.fail) return { exit_code: 1, result: null, error: { code: "internal", message: "bridge down" } };
    return { exit_code: 0, error: null, result: { id: "abc", domain: "demo", title: "T", revision: "rev2" } };
  });
});
afterEach(() => useToasts.setState({ items: [] }));

const stale = new LmError("stale", "stale_revision: demo:abc changed since revision rev1; read it again and redo the change", 6);

describe("a refused write", () => {
  it("reads the store and the note it names again when the note changed, and says so", async () => {
    const client = new QueryClient();
    client.setQueryData(["note", "demo:abc"], { revision: "rev1" });
    await expect(writeFailure(client, stale)).resolves.toBe(STALE_MESSAGE);
    expect(client.getQueryState(["note", "demo:abc"])?.isInvalidated).toBe(true);
    expect(reads.refs).toEqual(["demo:abc"]);
    await toastWriteFailure(client, stale);
    expect(useToasts.getState().items.map((t) => [t.kind, t.text])).toEqual([["warn", "This note changed; reloaded."]]);
  });

  // Codex review of e30902f, S4: a reload whose read fails must not be reported as done.
  it("does not say reloaded when the note could not be read again", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fail = false;
    const observer = new QueryObserver(client, { queryKey: ["note", "demo:abc"], queryFn: async () => { if (fail) throw new Error("bridge down"); return { revision: "rev1" }; } });
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    fail = true;
    await expect(writeFailure(client, stale)).resolves.toBe(STALE_UNREAD);
    expect(client.getQueryData(["note", "demo:abc"])).toEqual({ revision: "rev1" });
    // A caller's own reread decides too.
    fail = false;
    await expect(writeFailure(client, stale, () => Promise.reject(new Error("bridge down")))).resolves.toBe(STALE_UNREAD);
    await expect(writeFailure(client, stale, () => Promise.resolve())).resolves.toBe(STALE_MESSAGE);
    await toastWriteFailure(client, stale, () => Promise.reject(new Error("bridge down")));
    expect(useToasts.getState().items).toEqual([expect.objectContaining({ kind: "error", text: STALE_UNREAD, action: expect.objectContaining({ label: "Reload" }) })]);
    stop();
  });

  // Codex re-review, N04: "reloaded" means the affected read worked, not only that no note query failed.
  it("reads the note the refusal names, and a failed review list counts as not reloaded", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    reads.fail = true;
    await expect(writeFailure(client, stale)).resolves.toBe(STALE_UNREAD);
    reads.fail = false;
    let fail = false;
    const observer = new QueryObserver(client, { queryKey: ["review"], queryFn: async () => { if (fail) throw new Error("bridge down"); return { notes: [] }; } });
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    fail = true;
    const unnamed = new LmError("stale", "Stale revision: domains/demo/notes/a.md", 6);
    await expect(writeFailure(client, unnamed)).resolves.toBe(STALE_UNREAD);
    stop();
  });

  // Codex re-review, N04: with a reread, the store's own refresh is not waited for, so a stuck query cannot hold the form.
  it("answers from the reread without waiting for the rest of the store", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, { queryKey: ["list", "x"], queryFn: () => new Promise(() => {}) });
    const stop = observer.subscribe(() => {});
    await expect(writeFailure(client, stale, () => Promise.resolve())).resolves.toBe(STALE_MESSAGE);
    stop();
  });

  it("leaves the store alone for any other refusal and shows it as an error", async () => {
    const client = new QueryClient();
    client.setQueryData(["note", "demo:abc"], { revision: "rev1" });
    await toastWriteFailure(client, new LmError("revision_required", "revision_required: demo:abc needs the revision you read", 2));
    expect(client.getQueryState(["note", "demo:abc"])?.isInvalidated).toBe(false);
    expect(useToasts.getState().items).toEqual([expect.objectContaining({ kind: "error", text: expect.stringMatching(/bug in Hivemind/) })]);
  });
});
