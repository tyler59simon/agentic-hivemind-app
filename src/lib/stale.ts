// A write Living Memory refused because the note changed after Hivemind read it (`stale`, exit 6). Every write except the note
// editor's save, which merges, answers it the same way: read the store again so the note on screen is current, say so, and let
// the user repeat the action. Nothing is retried for them.
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../ui/toast";
import { classify } from "./errors";
import { refreshStore } from "./refresh";

export const STALE_MESSAGE = "This note changed; reloaded.";
/** A stale write whose note could not be read again: what is on screen is still the old note (Codex review of e30902f, S4). */
export const STALE_UNREAD = "This note changed, and Hivemind could not read it again. Reload, then try again.";

/** The queries that hold notes. Without a `reread`, the reload counts as done only when none of them failed. */
const NOTE_KEYS = ["note", "meta"];

/** Read the store again after a stale refusal. `reread` reads the notes the write named (and may keep what it read for the
 *  next try). False when the reading failed: a query refetch swallows its error, so the queries are checked here. */
export async function reloadAfterStale(client: QueryClient, reread?: () => Promise<unknown>): Promise<boolean> {
  const started = Date.now();
  await refreshStore(client);
  if (reread) return reread().then(() => true, () => false);
  return !client.getQueryCache().findAll({ predicate: (q) => NOTE_KEYS.includes(String(q.queryKey[0])) })
    .some((q) => q.state.status === "error" && q.state.errorUpdatedAt >= started);
}

/** What to tell the user about a failed write. For a stale one the store is read again first, and `reread` with it. */
export async function writeFailure(client: QueryClient, error: unknown, reread?: () => Promise<unknown>): Promise<string> {
  const problem = classify(error);
  if (problem.kind !== "stale") return problem.message;
  return (await reloadAfterStale(client, reread)) ? STALE_MESSAGE : STALE_UNREAD;
}

/** `writeFailure` as a toast: a warning for a stale write, an error for anything else. A note that could not be read again
 *  gets a toast with Reload. */
export async function toastWriteFailure(client: QueryClient, error: unknown, reread?: () => Promise<unknown>): Promise<void> {
  const message = await writeFailure(client, error, reread);
  if (message === STALE_UNREAD) toast(message, "error", { label: "Reload", run: () => void refreshStore(client) });
  else toast(message, message === STALE_MESSAGE ? "warn" : "error");
}
