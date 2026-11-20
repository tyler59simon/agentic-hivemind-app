// What the Notes page does to notebooks: open, create, rename and delete pages and sections. Each change goes through
// a Rust command; open tabs, documents and drafts follow renames, and tabs of a deleted page close.
import type { QueryClient } from "@tanstack/react-query";
import { movedPath, type FileRef } from "../../documents/keys";
import { beforeMove, discard, hold, keyOf, refresh, useDocuments } from "../../documents/store";
import { retargetAll } from "../../documents/sync";
import { classify } from "../../lib/errors";
import { forgetMoved } from "../../lib/drafts";
import { createFile, deleteFile, fileName, folderOf, isMarkdown, makeFolder, notebooksQuery, pageTitle, renameFile } from "../../lib/notebooks";
import { isLoose, saveAs } from "../../lib/opens";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Open a page in the focused pane (or beside it with `split`). Markdown opens for editing with a live preview. */
export function openPage(ref: FileRef, opts: { split?: boolean } = {}) {
  useWorkspace.getState().openTab({ kind: "file", file: ref, mode: isMarkdown(ref.path) ? "live" : "source", title: pageTitle(ref.path) }, opts);
}

/** The notebook new pages go into: the focused page's, else the first one. A file opened from outside every notebook
 *  has none (Codex review of 52051c8, R2). */
export function currentNotebook(fallback?: string): { notebook?: string; folder: string } {
  const ws = useWorkspace.getState();
  const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
  const tab = pane?.tabs.find((t) => t.id === pane.active);
  if (tab?.kind === "file" && tab.file && !isLoose(tab.file)) return { notebook: tab.file.notebook, folder: folderOf(tab.file.path) };
  return { notebook: fallback, folder: "" };
}

/** Try `Name.md`, `Name 2.md`, ... until one does not exist yet. */
async function createUnique(notebook: string, folder: string, base: string, text: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const path = join(folder, `${n === 1 ? base : `${base} ${n}`}.md`);
    try {
      await createFile(notebook, path, text);
      return path;
    } catch (e) {
      if (!/exists/i.test(String(e))) throw e;
    }
  }
  throw new Error(`Too many pages named ${base} in this folder`);
}

export async function newPage(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, "");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

export async function newSection(client: QueryClient, notebook: string, folder: string, name: string) {
  const path = join(folder, name.trim());
  await makeFolder(notebook, path);
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  return path;
}

/** Rename or move a page or section. Drafts, saves and loads of its open pages settle first and wait until the move is
 *  done, so nothing lands under the old name (Codex review of 32fd236, S2 and D7). */
export async function movePath(client: QueryClient, notebook: string, from: string, to: string) {
  if (from === to) return;
  const done = await beforeMove(notebook, from);
  // The destination is held too: a page opened there before its draft arrives would load without it (Codex review of
  // 52051c8, F2).
  const doneTo = await hold(notebook, to, "move");
  try {
    await renameFile(notebook, from, to);
    forgetMoved(notebook, from);
    retargetAll(notebook, from, to);
  } finally {
    done();
    doneTo();
  }
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
}

/** Save text as a new file the user picks (UTF-8, LF). A tab already showing that file takes the new text: it follows
 *  when clean and warns when it has edits (Codex review of 52051c8, D2). Null when the user cancelled. */
async function saveAsAndRefresh(text: string, suggested: string): Promise<FileRef | null> {
  const ref = await saveAs(text, suggested);
  if (ref) await refresh(ref.notebook, [ref.path]);
  return ref;
}

/** Save an untitled tab's text where the user picks; the tab then shows the saved file. */
export async function saveUntitled(tabId: string, text: string, suggested: string): Promise<FileRef | null> {
  const ref = await saveAsAndRefresh(text, suggested);
  if (!ref) return null;
  const ws = useWorkspace.getState();
  ws.setDirty(tabId, false);
  ws.updateTab(tabId, { kind: "file", file: ref, title: pageTitle(ref.path), mode: isMarkdown(ref.path) ? "live" : "source" });
  return ref;
}

/** Save a copy of a page's text where the user picks (it cannot be written in place), and open the copy. */
export async function saveCopy(text: string, name: string) {
  const ref = await saveAsAndRefresh(text, name);
  if (ref) openPage(ref);
}

/** The path after renaming `path` to `name` in place. A page keeps its extension when the new name has none; a section
 *  takes the name as typed, dots included (Codex review of 32fd236, U2). */
export function renamed(path: string, name: string, section = false) {
  const clean = name.trim();
  if (section) return join(folderOf(path), clean);
  const ext = fileName(path).match(/\.[^.]+$/)?.[0] ?? "";
  const withExt = ext && !/\.[^.]+$/.test(clean) ? `${clean}${ext}` : clean;
  return join(folderOf(path), withExt);
}

/** Close every tab showing `path` or a page under it; returns the pages they showed. */
export function closeTabsUnder(notebook: string, path: string) {
  const ws = useWorkspace.getState();
  const closed = new Map<string, FileRef>();
  for (const pane of ws.panes) {
    for (const tab of pane.tabs) {
      if (tab.kind !== "file" || tab.file?.notebook !== notebook || movedPath(tab.file.path, path, path) === null) continue;
      closed.set(keyOf(tab.file), tab.file);
      ws.closeTab(pane.id, tab.id);
    }
  }
  return closed;
}

/** Move a page or section to the notebook's trash; their drafts go too. Its tabs close before the file moves, and its
 *  pages are held: one opened from the tree meanwhile shows the delete instead of an editor, and a failed delete
 *  gives every page back with its edits (Codex re-reviews of c496e1c and b82e9ab, D8). */
export async function trashPath(client: QueryClient, notebook: string, path: string) {
  const done = await hold(notebook, path, "delete");
  try {
    const doc = useDocuments.getState().docs[keyOf({ notebook, path })];
    const closed = closeTabsUnder(notebook, path);
    try {
      await deleteFile(notebook, path, doc?.base?.stamp);
    } catch (e) {
      for (const ref of closed.values()) openPage(ref);
      throw e;
    }
    closeTabsUnder(notebook, path);
    for (const [key, ref] of Object.entries(useDocuments.getState().refs)) {
      if (ref.notebook === notebook && movedPath(ref.path, path, path) !== null) discard(key);
    }
  } finally {
    done();
  }
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
}

/** Ctrl+N on the Notes page: a new page in the focused page's notebook and folder, else the first notebook. */
export async function newPageHere(client: QueryClient) {
  const notebooks = await client.ensureQueryData(notebooksQuery());
  const { notebook, folder } = currentNotebook(notebooks[0]?.id);
  // With no notebook yet, Ctrl+N starts an untitled text file (NS-1B).
  if (!notebook) { useWorkspace.getState().openTab({ kind: "new-file" }); return; }
  await newPage(client, notebook, folder).catch((e) => toast(classify(e).message, "error"));
}
