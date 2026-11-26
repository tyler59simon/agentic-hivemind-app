import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../ui/toast";

/** Query keys that must not refetch on note changes: the connection (restarts the file watcher), git state,
 *  the architecture folder of a system and agent sessions (both have their own refresh). */
const KEEP = ["connect", "git", "diff", "architecture", "agent"];

/** Refetch everything that reads the store, except the connection and git queries. */
export const refreshStore = (client: QueryClient) =>
  client.invalidateQueries({ predicate: (q) => !KEEP.includes(String(q.queryKey[0])) });

/** Reconnect on the user's request: restart the Living Memory process, then read everything again, the connection first. A
 *  restart the bridge refused (a request still running) is reported, and the connection is read again all the same. */
export async function reconnect(client: QueryClient, restart: () => Promise<unknown>) {
  await restart().catch((e) => toast(e instanceof Error ? e.message : String(e), "warn"));
  await client.resetQueries();
}
