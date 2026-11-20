// Keeps the documents store and the workspace in step: a tab showing an unsaved page gets the unsaved dot, and a page
// no tab shows any more is let go (its draft stays). Also routes the notebook watcher's events.
import type { QueryClient } from "@tanstack/react-query";
import type { FilesChanged } from "../lib/notebooks";
import { useWorkspace } from "../workspace/store";
import { keyOf, refresh, release, retarget, useDocuments } from "./store";
import { isUnsaved } from "./session";

let paused = false;

function apply() {
  if (paused) return;
  const ws = useWorkspace.getState();
  const { docs, refs } = useDocuments.getState();
  const shown = new Set<string>();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind !== "file" || !tab.file) continue;
      const key = keyOf(tab.file);
      shown.add(key);
      const dirty = isUnsaved(docs[key]);
      if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
    }
  }
  for (const key of Object.keys(refs)) if (!shown.has(key)) release(key);
}

/** Start keeping both stores in step; returns the stop function. */
export function startDocumentSync() {
  const stops = [useWorkspace.subscribe(apply), useDocuments.subscribe(apply)];
  apply();
  return () => stops.forEach((stop) => stop());
}

/** A page or folder moved: documents and tabs follow together (one at a time would let `apply` drop the document
 *  while its tab still has the old path, or the other way round). */
export function retargetAll(notebook: string, from: string, to: string) {
  paused = true;
  try {
    retarget(notebook, from, to);
    useWorkspace.getState().retargetFile(notebook, from, to);
  } finally {
    paused = false;
  }
  apply();
}

/** Another program (or Hivemind's own tree actions) changed files in a notebook. */
export function onFilesChanged(client: QueryClient, { notebook, paths }: FilesChanged) {
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  if (paths.some((p) => p.toLowerCase() === ".hivemind/notebook.json")) client.invalidateQueries({ queryKey: ["notebook-meta", notebook] });
  void refresh(notebook, paths);
}
