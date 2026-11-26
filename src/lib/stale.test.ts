// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { useToasts } from "../ui/toast";
import { LmError } from "./lm";
import { STALE_MESSAGE, STALE_UNREAD, toastWriteFailure, writeFailure } from "./stale";

afterEach(() => useToasts.setState({ items: [] }));

describe("a refused write", () => {
  it("reads the store again when the note changed, and says so", async () => {
    const client = new QueryClient();
    client.setQueryData(["note", "demo:abc"], { revision: "rev1" });
    const stale = new LmError("stale", "stale_revision: demo:abc changed since revision rev1; read it again and redo the change", 6);
    await expect(writeFailure(client, stale)).resolves.toBe(STALE_MESSAGE);
    expect(client.getQueryState(["note", "demo:abc"])?.isInvalidated).toBe(true);
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
    const stale = new LmError("stale", "stale_revision: demo:abc changed since revision rev1; read it again and redo the change", 6);
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

  it("leaves the store alone for any other refusal and shows it as an error", async () => {
    const client = new QueryClient();
    client.setQueryData(["note", "demo:abc"], { revision: "rev1" });
    await toastWriteFailure(client, new LmError("revision_required", "revision_required: demo:abc needs the revision you read", 2));
    expect(client.getQueryState(["note", "demo:abc"])?.isInvalidated).toBe(false);
    expect(useToasts.getState().items).toEqual([expect.objectContaining({ kind: "error", text: expect.stringMatching(/bug in Hivemind/) })]);
  });
});
