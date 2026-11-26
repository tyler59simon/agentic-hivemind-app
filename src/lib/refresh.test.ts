import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { useToasts } from "../ui/toast";
import { reconnect, refreshStore } from "./refresh";

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

// Codex review of e30902f, C2: Reconnect restarts Living Memory before the connection is read again, so a Living Memory
// upgraded in place answers the new connect.
describe("reconnect", () => {
  it("restarts the bridge, then reads the connection again", async () => {
    const order: string[] = [];
    const client = new QueryClient();
    let connects = 0;
    const observer = new QueryObserver(client, { queryKey: ["connect"], staleTime: Infinity, queryFn: () => { connects += 1; order.push("connect"); return connects; } });
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await reconnect(client, () => new Promise((done) => setTimeout(() => { order.push("restart"); done(undefined); }, 20)));
    expect(order).toEqual(["connect", "restart", "connect"]);
    expect(client.getQueryData(["connect"])).toBe(2);
    stop();
  });

  it("says why a restart was refused, and still reads the connection again", async () => {
    const client = new QueryClient();
    client.setQueryData(["connect"], 1);
    await reconnect(client, () => Promise.reject("A Living Memory request is still running, so Hivemind did not restart it. Reconnect again when it finishes."));
    expect(useToasts.getState().items.map((t) => [t.kind, t.text])).toEqual([["warn", "A Living Memory request is still running, so Hivemind did not restart it. Reconnect again when it finishes."]]);
    expect(client.getQueryState(["connect"])?.data).toBeUndefined();
    useToasts.setState({ items: [] });
  });
});
