// A write Living Memory refused because the note changed after Hivemind read it (`stale`, exit 6). Every write except the note
// editor's save, which merges, answers it the same way: read the store again so the note on screen is current, say so, and let
// the user repeat the action. Nothing is retried for them.
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../ui/toast";
import { classify } from "./errors";
import { meta } from "./lm";
import { refreshStore } from "./refresh";

export const STALE_MESSAGE = "This note changed; reloaded.";
/** A stale write whose note could not be read again: what is on screen is still the old note (Codex review of e30902f, S4). */
export const STALE_UNREAD = "This note changed, and Hivemind could not read it again. Reload, then try again.";

/** The queries that show notes and the rows writes are made from. Without a `reread`, the reload counts as done only when
 *  none of them failed. */
const NOTE_KEYS = ["note", "meta", "review", "list"];

/** How long a reload may take before it counts as failed: a paused query (the webview offline) must not hold a form. */
export const RELOAD_LIMIT = 15_000;

/** A caller's own read after a stale refusal. `signal` is aborted when the read took too long and counted as failed: a
 *  result that comes later must not change what the form shows (Codex re-review, F07). */
export type Reread = (signal: AbortSignal) => Promise<unknown>;

/** Whether `work` finished within RELOAD_LIMIT without an error. `late` is aborted when it did not finish in time. */
const within = (work: Promise<unknown>, late?: AbortController) => Promise.race([
  work.then(() => true, () => false),
  new Promise<boolean>((done) => setTimeout(() => { late?.abort(); done(false); }, RELOAD_LIMIT)),
]);

/** Read the store again after a stale refusal. `reread` reads the notes the write named (and may keep what it read for the
 *  next try): the answer is whether it worked, and the rest of the store refreshes on its own. Without one, the whole
 *  refresh is waited for and the note queries are checked, since a query refetch swallows its error (Codex re-review, N04). */
export async function reloadAfterStale(client: QueryClient, reread?: Reread): Promise<boolean> {
  if (reread) {
    void refreshStore(client);
    const late = new AbortController();
    return within(reread(late.signal), late);
  }
  const started = Date.now();
  if (!(await within(refreshStore(client)))) return false;
  return !client.getQueryCache().findAll({ predicate: (q) => NOTE_KEYS.includes(String(q.queryKey[0])) })
    .some((q) => q.state.status === "error" && q.state.errorUpdatedAt >= started);
}

/** The note a stale refusal names (`stale_revision: REF changed since revision ...`), if it names one. */
const staleRef = (message: string) => /^stale_revision: (\S+:\S+) changed since revision/.exec(message)?.[1];

/** What to tell the user about a failed write. For a stale one the store is read again first, and `reread` with it; without
 *  a `reread`, the note the refusal names is read itself, so "reloaded" means the note that changed was read again. */
export async function writeFailure(client: QueryClient, error: unknown, reread?: Reread): Promise<string> {
  const problem = classify(error);
  if (problem.kind !== "stale") return problem.message;
  const ref = reread ? undefined : staleRef(problem.message);
  const reloaded = ref
    ? (await reloadAfterStale(client)) && (await within(meta(ref)))
    : await reloadAfterStale(client, reread);
  return reloaded ? STALE_MESSAGE : STALE_UNREAD;
}

/** `writeFailure` as a toast: a warning for a stale write, an error for anything else. A note that could not be read again
 *  gets a toast with Reload. */
export async function toastWriteFailure(client: QueryClient, error: unknown, reread?: Reread): Promise<void> {
  const message = await writeFailure(client, error, reread);
  if (message === STALE_UNREAD) toast(message, "error", { label: "Reload", run: () => void refreshStore(client) });
  else toast(message, message === STALE_MESSAGE ? "warn" : "error");
}
