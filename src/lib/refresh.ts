import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../ui/toast";

/** Query keys that must not refetch on note changes: the connection (restarts the file watcher), git state,
 *  the architecture folder of a system and agent sessions (both have their own refresh). */
const KEEP = ["connect", "git", "diff", "architecture", "agent"];

/** Refetch everything that reads the store, except the connection and git queries. */
export const refreshStore = (client: QueryClient) =>
  client.invalidateQueries({ predicate: (q) => !KEEP.includes(String(q.queryKey[0])) });

/** The reconnect in progress, which a second click joins instead of restarting again (Codex re-review, F03). */
let pending: Promise<void> | null = null;

/** Reconnect on the user's request: restart the Living Memory process, then read everything again, the connection first. A
 *  restart the bridge refused (a request still running) is reported, and nothing is read again: the process and its
 *  connection are the ones already shown (Codex re-review, F01). */
export function reconnect(client: QueryClient, restart: () => Promise<unknown>): Promise<void> {
  pending ??= (async () => {
    try {
      await restart();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "warn");
      return;
    }
    await client.resetQueries();
  })().finally(() => { pending = null; });
  return pending;
}
