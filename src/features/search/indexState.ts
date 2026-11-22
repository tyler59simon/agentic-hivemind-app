// How far the search index is (NS-4A): the last `index-progress` event, for the status line and the notebook settings. Every
// time the index settles, the queries that read it are asked again, a moment later so a burst of saves refreshes them once.
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { INDEX_KEY, type IndexProgress } from "../../lib/noteindex";

export const useIndexState = create<{ progress: IndexProgress | null }>(() => ({ progress: null }));

const REFRESH_MS = 300;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The `index-progress` event. */
export function onIndexProgress(client: QueryClient, progress: IndexProgress) {
  useIndexState.setState({ progress });
  if (progress.state !== "idle") return;
  clearTimeout(timer);
  timer = setTimeout(() => client.invalidateQueries({ queryKey: [INDEX_KEY] }), REFRESH_MS);
}

/** "Indexing pages: 120 of 800" (or "Reading pages for meaning search: 120 of 800"), or null while the index is idle. */
export function progressLine(progress: IndexProgress | null): string | null {
  if (!progress || progress.state !== "scanning") return null;
  const what = progress.phase === "meaning" ? "Reading pages for meaning search" : "Indexing pages";
  return progress.total ? `${what}: ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : `${what}…`;
}
