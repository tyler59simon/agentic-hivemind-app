// Keeps the documents store and the workspace in step: a tab showing an unsaved page gets the unsaved dot, and a page
// no tab shows any more is let go (its draft stays). Also routes the notebook watcher's events.
import type { QueryClient } from "@tanstack/react-query";
import type { FilesChanged } from "../lib/notebooks";
import { lmContainer } from "./adapters/lmdoc";
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

/** The `docs-changed` event: files of a Living Memory notebook changed (NS-2C). */
export interface DocsChanged { domain: string; notebook: string; paths: string[] }

/** Living Memory changed a notebook's files (an agent's proposal, an Obsidian edit, Hivemind's own saves). The tree
 *  follows, open pages follow or warn, and the notebook list and proposals refresh when their files changed. */
export function onDocsChanged(client: QueryClient, { domain, notebook, paths }: DocsChanged) {
  const container = lmContainer(domain, notebook);
  client.invalidateQueries({ queryKey: ["notebook-tree", container] });
  if (paths.some((p) => p === "notebook.json" || p.startsWith(".proposals/"))) client.invalidateQueries({ queryKey: ["lm-notebooks"] });
  if (paths.some((p) => p.startsWith(".proposals/"))) client.invalidateQueries({ queryKey: ["lm-proposals", domain, notebook] });
  // `![[picture.png]]` looks among the notebook's attachments (Codex re-review of 87a0a1f).
  if (paths.some((p) => /^assets\//i.test(p))) client.invalidateQueries({ queryKey: ["lm-assets", container] });
  const pages = paths.filter((p) => /\.md$/i.test(p) && !p.startsWith(".") && !/^assets\//i.test(p));
  // The proposal open in the inbox compares against its page as it is now: either changing asks for it again, so the
  // inbox moves from Accept to Merge when the page moves on (Codex review of 32fee20, U1).
  if (pages.length || paths.some((p) => p.startsWith(".proposals/"))) client.invalidateQueries({ queryKey: ["lm-proposal"] });
  if (pages.length) void refresh(container, pages);
}

/** Another program (or Hivemind's own tree actions) changed files in a notebook. */
export function onFilesChanged(client: QueryClient, { notebook, paths }: FilesChanged) {
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  if (paths.some((p) => p.toLowerCase() === ".hivemind/notebook.json")) client.invalidateQueries({ queryKey: ["notebook-meta", notebook] });
  void refresh(notebook, paths);
}
