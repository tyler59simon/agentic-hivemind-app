import type { QueryClient } from "@tanstack/react-query";

/** Query keys that must not refetch on note changes: the connection (restarts the file watcher) and git state. */
const KEEP = ["connect", "git", "diff"];

/** Refetch everything that reads the store, except the connection and git queries. */
export const refreshStore = (client: QueryClient) =>
  client.invalidateQueries({ predicate: (q) => !KEEP.includes(String(q.queryKey[0])) });
