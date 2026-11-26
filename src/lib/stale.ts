// A write Living Memory refused because the note changed after Hivemind read it (`stale`, exit 6). Every write except the note
// editor's save, which merges, answers it the same way: read the store again so the note on screen is current, say so, and let
// the user repeat the action. Nothing is retried for them.
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "../ui/toast";
import { classify } from "./errors";
import { refreshStore } from "./refresh";

export const STALE_MESSAGE = "This note changed; reloaded.";

/** What to tell the user about a failed write. For a stale one the store is read again first. */
export async function writeFailure(client: QueryClient, error: unknown): Promise<string> {
  const problem = classify(error);
  if (problem.kind !== "stale") return problem.message;
  await refreshStore(client);
  return STALE_MESSAGE;
}

/** `writeFailure` as a toast: a warning for a stale write, an error for anything else. */
export async function toastWriteFailure(client: QueryClient, error: unknown): Promise<void> {
  const message = await writeFailure(client, error);
  toast(message, message === STALE_MESSAGE ? "warn" : "error");
}
