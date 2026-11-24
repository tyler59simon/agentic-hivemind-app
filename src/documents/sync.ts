// Keeps the documents store and the workspace in step: a tab showing an unsaved page gets the unsaved dot, and a page
// no tab shows any more is let go (its draft stays). Also routes the notebook watcher's events.
import type { QueryClient } from "@tanstack/react-query";
import { movedPath } from "./keys";
import { isDocx, isPdf, type FilesChanged } from "../lib/notebooks";
import { docxKey, isDocxDirty, refreshDocxOnDisk, releaseDocx, retargetDocx, useDocxStore } from "../features/docx/store";
import { isPdfDirty, pdfKey, refreshPdfOnDisk, releasePdf, retargetPdf, usePdfStore } from "../features/pdf/store";
import { lmContainer } from "./adapters/lmdoc";
import { useWorkspace } from "../workspace/store";
import { toast } from "../ui/toast";
import { keyOf, onReleaseRefused, refresh, release, retarget, useDocuments } from "./store";
import { isUnsaved } from "./session";

let paused = false;

function apply() {
  if (paused) return;
  const ws = useWorkspace.getState();
  const { docs, refs, held } = useDocuments.getState();
  const isHeldRef = (ref: { notebook: string; path: string } | undefined) =>
    !!ref && held.some((h) => h.notebook === ref.notebook && movedPath(ref.path, h.from, h.from) !== null);
  const docxSessions = useDocxStore.getState().sessions;
  const pdfSessions = usePdfStore.getState().sessions;
  const shown = new Set<string>();
  const shownDocx = new Set<string>();
  const shownPdf = new Set<string>();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      // A comparison holds both of its files, and is unsaved when either is (NS-6A).
      if (tab.kind === "compare" && tab.compare) {
        const keys = [keyOf(tab.compare.left), keyOf(tab.compare.right)];
        keys.forEach((k) => shown.add(k));
        const dirty = keys.some((k) => isUnsaved(docs[k]));
        if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
        continue;
      }
      if (tab.kind !== "file" || !tab.file) continue;
      if (isDocx(tab.file.path)) {
        const key = docxKey(tab.file);
        shownDocx.add(key);
        const dirty = isDocxDirty(docxSessions[key]);
        if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
        continue;
      }
      if (isPdf(tab.file.path)) {
        const key = pdfKey(tab.file);
        shownPdf.add(key);
        const dirty = isPdfDirty(pdfSessions[key]);
        if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
        continue;
      }
      const key = keyOf(tab.file);
      shown.add(key);
      const dirty = isUnsaved(docs[key]);
      if (!!ws.dirty[tab.id] !== dirty) ws.setDirty(tab.id, dirty);
    }
  }
  for (const key of Object.keys(refs)) if (!shown.has(key)) release(key);
  const docxRefs = useDocxStore.getState().refs;
  for (const key of Object.keys(docxRefs)) if (!shownDocx.has(key) && !isHeldRef(docxRefs[key])) releaseDocx(key);
  const pdfRefs = usePdfStore.getState().refs;
  for (const key of Object.keys(pdfRefs)) if (!shownPdf.has(key) && !isHeldRef(pdfRefs[key])) releasePdf(key);
}

/** Start keeping both stores in step; returns the stop function. */
export function startDocumentSync() {
  const stops = [
    useWorkspace.subscribe(apply),
    useDocuments.subscribe(apply),
    useDocxStore.subscribe(apply),
    usePdfStore.subscribe(apply),
  ];
  // The last tab of a page was closed but its unsaved edits cannot be kept as a draft: the page comes back in a tab, which
  // says so and offers to save it, save a copy or discard the edits (Codex review of 7320d7f, DATA-5).
  onReleaseRefused((_key, file, reason) => {
    if (file) useWorkspace.getState().openTab({ kind: "file", file });
    toast(`${file?.path ?? "A page"} has unsaved edits that could not be kept as a draft (${reason}), so it stays open. Save it, save a copy or discard the edits.`, "error");
  });
  apply();
  return () => { stops.forEach((stop) => stop()); onReleaseRefused(() => {}); };
}

/** A page or folder moved: documents and tabs follow together (one at a time would let `apply` drop the document
 *  while its tab still has the old path, or the other way round). */
export function retargetAll(notebook: string, from: string, to: string) {
  paused = true;
  try {
    retarget(notebook, from, to);
    retargetDocx(notebook, from, to);
    retargetPdf(notebook, from, to);
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
  const hasFolderProposals = paths.some((p) => p.startsWith(".folder-proposals/"));
  if (hasFolderProposals) {
    client.invalidateQueries({ queryKey: ["lm-proposals", "*"] });
    client.invalidateQueries({ queryKey: ["lm-proposal"] });
  }
  const rest = paths.filter((p) => !p.startsWith(".folder-proposals/"));
  if (!rest.length) return;
  const container = lmContainer(domain, notebook);
  client.invalidateQueries({ queryKey: ["notebook-tree", container] });
  if (rest.some((p) => p === "notebook.json" || p.startsWith(".proposals/"))) client.invalidateQueries({ queryKey: ["lm-notebooks"] });
  if (rest.some((p) => p === "notebook.json")) client.invalidateQueries({ queryKey: ["daily-settings", container] });
  if (rest.some((p) => p.startsWith(".proposals/"))) {
    client.invalidateQueries({ queryKey: ["lm-proposals", domain, notebook] });
    client.invalidateQueries({ queryKey: ["lm-proposals", "*"] });
  }
  // `![[picture.png]]` looks among the notebook's attachments (Codex re-review of 87a0a1f).
  if (rest.some((p) => /^assets\//i.test(p))) client.invalidateQueries({ queryKey: ["lm-assets", container] });
  const pages = rest.filter((p) => /\.md$/i.test(p) && !p.startsWith(".") && !/^assets\//i.test(p));
  // The proposal open in the inbox compares against its page as it is now: either changing asks for it again, so the
  // inbox moves from Accept to Merge when the page moves on (Codex review of 32fee20, U1).
  if (pages.length || rest.some((p) => p.startsWith(".proposals/"))) client.invalidateQueries({ queryKey: ["lm-proposal"] });
  if (pages.length) void refresh(container, pages);
}

/** Another program (or Hivemind's own tree actions) changed files in a notebook. */
export function onFilesChanged(client: QueryClient, { notebook, paths }: FilesChanged) {
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  if (paths.some((p) => p.toLowerCase() === ".hivemind/notebook.json")) {
    client.invalidateQueries({ queryKey: ["notebook-meta", notebook] });
    client.invalidateQueries({ queryKey: ["daily-settings", notebook] });
  }
  if (paths.some((p) => /\.(md|markdown)$/i.test(p))) client.invalidateQueries({ queryKey: ["lm-proposal"] });
  void refresh(notebook, paths);
  void refreshDocxOnDisk(notebook, paths);
  void refreshPdfOnDisk(notebook, paths);
}

/** The Quick capture window added a line to a page (NS-7A). Rust's own writes are not reported by the watcher, so the window
 *  says so: the tree follows, and an open copy of the page follows the file or, when it has unsaved edits, keeps them and
 *  warns (it merges the new line in when it is saved). */
export function onPageAppended(client: QueryClient, { notebook, path }: { notebook: string; path: string }) {
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  void refresh(notebook, [path]);
}
