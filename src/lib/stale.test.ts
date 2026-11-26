// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { useToasts } from "../ui/toast";
import { LmError } from "./lm";
import { STALE_MESSAGE, toastWriteFailure, writeFailure } from "./stale";

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

  it("leaves the store alone for any other refusal and shows it as an error", async () => {
    const client = new QueryClient();
    client.setQueryData(["note", "demo:abc"], { revision: "rev1" });
    await toastWriteFailure(client, new LmError("revision_required", "revision_required: demo:abc needs the revision you read", 2));
    expect(client.getQueryState(["note", "demo:abc"])?.isInvalidated).toBe(false);
    expect(useToasts.getState().items).toEqual([expect.objectContaining({ kind: "error", text: expect.stringMatching(/bug in Hivemind/) })]);
  });
});
