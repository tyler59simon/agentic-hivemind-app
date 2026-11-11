import type { QueryClient } from "@tanstack/react-query";

/** Query keys that must not refetch on note changes: the connection (restarts the file watcher), git state,
 *  the architecture folder of a system and agent sessions (both have their own refresh). */
const KEEP = ["connect", "git", "diff", "architecture", "agent"];

/** Refetch everything that reads the store, except the connection and git queries. */
export const refreshStore = (client: QueryClient) =>
  client.invalidateQueries({ predicate: (q) => !KEEP.includes(String(q.queryKey[0])) });
