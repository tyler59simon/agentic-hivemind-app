import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshStore } from "./refresh";

describe("refreshStore", () => {
  it("invalidates store queries but not connect, git or diff", async () => {
    const client = new QueryClient();
    const keys = [["connect"], ["git", "status"], ["diff", "x"], ["list", "demo"], ["projects"], ["note", "a:b"]];
    for (const k of keys) client.setQueryData(k, 1);
    await refreshStore(client);
    const stale = (k: string[]) => client.getQueryState(k)!.isInvalidated;
    expect(keys.filter(stale).map((k) => k[0])).toEqual(["list", "projects", "note"]);
  });
});
