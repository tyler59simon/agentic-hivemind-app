// What the Notes page does to notebooks: open, create, rename and delete pages and sections. Each change goes through
// a Rust command; open tabs, documents and drafts follow renames, and tabs of a deleted page close.
import type { QueryClient } from "@tanstack/react-query";
import { movedPath, type FileRef } from "../../documents/keys";
import { beforeMove, discard, hold, keyOf, useDocuments } from "../../documents/store";
import { retargetAll } from "../../documents/sync";
import { classify } from "../../lib/errors";
import { forgetMoved } from "../../lib/drafts";
import { createFile, deleteFile, fileName, folderOf, isMarkdown, makeFolder, notebooksQuery, pageTitle, renameFile } from "../../lib/notebooks";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Open a page in the focused pane (or beside it with `split`). Markdown opens for editing with a live preview. */
export function openPage(ref: FileRef, opts: { split?: boolean } = {}) {
  useWorkspace.getState().openTab({ kind: "file", file: ref, mode: isMarkdown(ref.path) ? "live" : "source", title: pageTitle(ref.path) }, opts);
}

/** The notebook new pages go into: the focused page's, else the first one. */
export function currentNotebook(fallback?: string): { notebook?: string; folder: string } {
  const ws = useWorkspace.getState();
  const pane = ws.panes.find((p) => p.id === ws.focused) ?? ws.panes[0];
  const tab = pane?.tabs.find((t) => t.id === pane.active);
  if (tab?.kind === "file" && tab.file) return { notebook: tab.file.notebook, folder: folderOf(tab.file.path) };
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
  try {
    await renameFile(notebook, from, to);
    forgetMoved(notebook, from);
    retargetAll(notebook, from, to);
  } finally {
    done();
  }
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
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
function closeTabsUnder(notebook: string, path: string) {
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
  if (!notebook) { toast("Add a notebook first: pick any folder of Markdown files.", "warn"); return; }
  await newPage(client, notebook, folder).catch((e) => toast(classify(e).message, "error"));
}
