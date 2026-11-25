// What the Notes page does to notebooks: open, create, rename and delete pages and sections. Each change goes through
// a Rust command; open tabs, documents and drafts follow renames, and tabs of a deleted page close.
import type { QueryClient } from "@tanstack/react-query";
import { movedPath, type FileRef } from "../../documents/keys";
import { beforeMove, discard, edit, hold, keyOf, open, refresh, unsavedUnder, useDocuments } from "../../documents/store";
import { retargetAll } from "../../documents/sync";
import { classify } from "../../lib/errors";
import { forgetMoved } from "../../lib/drafts";
import { createDoc, createSection, deleteDoc, moveDoc, readDoc } from "../../documents/io";
import { NEW_CANVAS_TEXT } from "../canvas/model";
import { NEW_DRAWIO_TEXT } from "../drawio/starter";
import { NEW_MERMAID_TEXT } from "../mermaid/starter";
import { NEW_SVG_TEXT } from "../svg/svg";
import { newPageText } from "../hmdoc/envelope";
import { planFor, useRewritePlan } from "../links/plan";
import { createDocx } from "../../lib/docx";
import { createPdfBytes } from "../../lib/pdf";
import { discardDocxUnder, docxKey, unsavedDocxUnder, useDocxStore, waitDocxSaves } from "../docx/store";
import { discardPdfUnder, pdfKey, unsavedPdfUnder, usePdfStore, waitPdfSaves } from "../pdf/store";
import { fileName, folderOf, isCanvas, isDocx, isDrawio, isMarkdown, isMermaid, isPdf, isRichDoc, isSvg, notebooksQuery, pageTitle } from "../../lib/notebooks";
import { isLoose, saveAs, saveBytesAs } from "../../lib/opens";
import { untitledText } from "./untitled";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Open a page in the focused pane (or beside it with `split`). Markdown opens for editing with a live preview. */
export function openPage(ref: FileRef, opts: { split?: boolean } = {}) {
  const mode = isMarkdown(ref.path) ? "live"
    : isCanvas(ref.path) || isDrawio(ref.path) ? "board"
    : isSvg(ref.path) || isDocx(ref.path) || isPdf(ref.path) ? "preview"
    : isMermaid(ref.path) ? "split"
    : "source";
  useWorkspace.getState().openTab({ kind: "file", file: ref, mode, title: pageTitle(ref.path) }, opts);
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

/** Try `Name.md`, `Name 2.md`, ... until one does not exist yet. `text` may depend on the name that was free (a rich
 *  page keeps its name as its title). */
export async function createUnique(notebook: string, folder: string, base: string, text: string | ((name: string) => string), ext = "md"): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    const path = join(folder, `${name}.${ext}`);
    try {
      await createDoc(notebook, path, typeof text === "function" ? text(name) : text);
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

/** A new rich page (NS-3C): `Untitled.hmdoc` with one empty paragraph, under a free name. */
export async function newRichPage(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, newPageText, "hmdoc");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

/** A new canvas board (NS-7C): `Untitled.canvas` with no cards, under a free name. */
export async function newCanvas(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, NEW_CANVAS_TEXT, "canvas");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

/** A new Mermaid diagram: `Untitled.mmd` with a starter flowchart. */
export async function newMermaid(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, NEW_MERMAID_TEXT, "mmd");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

/** A new Draw.io diagram: `Untitled.drawio` with one blank page. */
export async function newDrawio(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, NEW_DRAWIO_TEXT, "drawio");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

/** A new SVG file: `Untitled.svg` with a starter viewBox. */
export async function newSvg(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const path = await createUnique(notebook, folder, title, NEW_SVG_TEXT, "svg");
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  openPage({ notebook, path });
  return path;
}

/** A new Word document: `Untitled.docx` with minimal OOXML structure. */
export async function newDocx(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? title : `${title} ${n}`;
    const path = join(folder, `${name}.docx`);
    try {
      await createDocx(notebook, path);
      client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
      openPage({ notebook, path });
      return path;
    } catch (e) {
      if (!/exists/i.test(String(e))) throw e;
    }
  }
  throw new Error(`Too many documents named ${title} in this folder`);
}

/** A new blank PDF document: `Untitled.pdf` with one empty US Letter page (612 x 792 pt). */
export async function newPdf(client: QueryClient, notebook: string, folder = "", title = "Untitled") {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  const bytes = await pdf.save();
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? title : `${title} ${n}`;
    const path = join(folder, `${name}.pdf`);
    try {
      await createPdfBytes(notebook, path, bytes);
      client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
      openPage({ notebook, path });
      return path;
    } catch (e) {
      if (!/exists/i.test(String(e))) throw e;
    }
  }
  throw new Error(`Too many PDFs named ${title} in this folder`);
}

/** The text of a page as it is now: an open page's, unsaved edits included, else the file's. */
async function currentText(ref: FileRef): Promise<string> {
  const open = useDocuments.getState().docs[keyOf(ref)];
  return open && open.status !== "loading" && open.status !== "error" ? open.text : (await readDoc(ref)).text;
}

/** Convert a Markdown page to a rich page beside it (the Markdown page is not changed) and open it. `text` is the text to
 *  convert when the caller has it (an open page). */
export async function convertToRich(client: QueryClient, ref: FileRef, text?: string) {
  const source = text ?? await currentText(ref);
  const { convertMarkdown } = await import("../hmdoc/convert");
  const converted = convertMarkdown(source, pageTitle(ref.path));
  const path = await createUnique(ref.notebook, folderOf(ref.path), pageTitle(ref.path), converted, "hmdoc");
  client.invalidateQueries({ queryKey: ["notebook-tree", ref.notebook] });
  openPage({ notebook: ref.notebook, path });
  return path;
}

/** Export a rich page to a Markdown page beside it. Returns where it went and what the Markdown could not keep. */
export async function exportToMarkdown(client: QueryClient, ref: FileRef, text?: string) {
  const source = text ?? await currentText(ref);
  const { exportText } = await import("../hmdoc/toMarkdown");
  const out = exportText(source, folderOf(ref.path));
  if (!out.ok) throw new Error(out.reason);
  const path = await createUnique(ref.notebook, folderOf(ref.path), pageTitle(ref.path), out.markdown);
  client.invalidateQueries({ queryKey: ["notebook-tree", ref.notebook] });
  return { path, report: out.report };
}

/** A conflict on a rich page or a canvas: the user's version goes to `Name (my edits).hmdoc` (or `.canvas`) beside it, under
 *  a free name. */
export async function saveBothVersions(client: QueryClient, ref: FileRef, text: string) {
  const canvas = isCanvas(ref.path);
  const drawio = isDrawio(ref.path);
  const ext = canvas ? "canvas" : drawio ? (ref.path.toLowerCase().endsWith(".dio") ? "dio" : "drawio") : "hmdoc";
  const stem = pageTitle(ref.path).replace(/\.(canvas|drawio|dio)$/i, "");
  const path = await createUnique(ref.notebook, folderOf(ref.path), `${stem} (my edits)`, text, ext);
  client.invalidateQueries({ queryKey: ["notebook-tree", ref.notebook] });
  return path;
}

export async function newSection(client: QueryClient, notebook: string, folder: string, name: string) {
  const path = join(folder, name.trim());
  await createSection(notebook, path);
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  return path;
}

/** Rename or move a page or section. Drafts, saves and loads of its open pages settle first and wait until the move is
 *  done, so nothing lands under the old name (Codex review of 32fd236, S2 and D7). Links to what moved are worked out before
 *  it moves and offered for rewriting once it has (NS-4A). */
export async function movePath(client: QueryClient, notebook: string, from: string, to: string) {
  if (from === to) return;
  const done = await beforeMove(notebook, from);
  // The destination is held too: a page opened there before its draft arrives would load without it (Codex review of
  // 52051c8, F2), and one open there takes no edits the move would replace (final review of a34fafd, F2a).
  const doneTo = await hold(notebook, to, "into");
  let plan: Awaited<ReturnType<typeof planFor>> = null;
  try {
    await Promise.all([
      waitDocxSaves(notebook, from),
      waitPdfSaves(notebook, from),
      waitDocxSaves(notebook, to),
      waitPdfSaves(notebook, to),
    ]);
    // A page at the destination with unsaved edits would be overwritten by the move (Codex re-review of fa08348, F2).
    if (unsavedUnder(notebook, to).length || unsavedDocxUnder(notebook, to).length || unsavedPdfUnder(notebook, to).length) {
      throw new Error(`${to} has unsaved edits; save or discard them first`);
    }
    plan = await planFor(client, notebook, from, to);
    await moveDoc(notebook, from, to);
    forgetMoved(notebook, from);
    retargetAll(notebook, from, to);
  } finally {
    done();
    doneTo();
  }
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  if (plan) useRewritePlan.setState({ plan });
}

/** Save text as a new file the user picks (UTF-8, LF). A tab already showing that file takes the new text: it follows
 *  when clean and warns when it has edits (Codex review of 52051c8, D2). Null when the user cancelled. */
async function saveAsAndRefresh(text: string, suggested: string): Promise<FileRef | null> {
  const ref = await saveAs(text, suggested);
  if (ref) await refresh(ref.notebook, [ref.path]);
  return ref;
}

/** Untitled tabs with a Save as in progress. A second one for the same tab does nothing, even from a remounted view
 *  (Codex final review of a34fafd, N3c). */
const savingUntitled = new Set<string>();

const isUntitled = (tabId: string) => useWorkspace.getState().panes.some((p) => p.tabs.some((t) => t.id === tabId && t.kind === "new-file"));

/** Save an untitled tab's text where the user picks; the tab then shows the saved file. Null when the user cancelled
 *  or a Save as of this tab is already running. */
export async function saveUntitled(tabId: string, text: string, suggested: string): Promise<FileRef | null> {
  if (savingUntitled.has(tabId)) return null;
  savingUntitled.add(tabId);
  try {
    const ref = await saveAsAndRefresh(text, suggested);
    if (!ref || !isUntitled(tabId)) return ref;
    if (untitledText(tabId) !== text) {
      // Typing went on during Save as (Codex re-review of fa08348, N3). The newer text becomes unsaved edits of the
      // saved file only when that file opens for editing with no edits of its own; otherwise this tab keeps it and stays
      // untitled. The buffer goes only once the file has the text (final review of a34fafd, N3a and N3b).
      await open(ref);
      const key = keyOf(ref);
      if (!isUntitled(tabId)) return ref;
      if (useDocuments.getState().docs[key]?.status !== "clean") {
        toast(`Saved ${fileName(ref.path)}. What you typed during the save is still in this tab; save it again to keep it.`, "error");
        return ref;
      }
      edit(key, untitledText(tabId));
    }
    const ws = useWorkspace.getState();
    ws.setDirty(tabId, false);
    ws.updateTab(tabId, { kind: "file", file: ref, title: pageTitle(ref.path), mode: isMarkdown(ref.path) ? "live" : isCanvas(ref.path) ? "board" : "source" });
    return ref;
  } finally {
    savingUntitled.delete(tabId);
  }
}

/** Save a copy of a page's text where the user picks (it cannot be written in place), and open the copy. */
export async function saveCopy(text: string, name: string) {
  const ref = await saveAsAndRefresh(text, name);
  if (ref) openPage(ref);
}

/** Save a binary copy (`.pdf`, `.docx`, `.png`, ...) where the user picks. Opens the copy when `openAfter` is true. */
export async function saveBinaryCopy(bytes: Uint8Array, name: string, openAfter = false): Promise<FileRef | null> {
  const ref = await saveBytesAs(bytes, name);
  if (ref && openAfter) openPage(ref);
  return ref;
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
    await Promise.all([waitDocxSaves(notebook, path), waitPdfSaves(notebook, path)]);
    const ref = { notebook, path };
    const doc = useDocuments.getState().docs[keyOf(ref)];
    const binStamp = useDocxStore.getState().sessions[docxKey(ref)]?.stamp
      ?? usePdfStore.getState().sessions[pdfKey(ref)]?.stamp
      ?? undefined;
    const closed = closeTabsUnder(notebook, path);
    try {
      await deleteDoc(notebook, path, doc?.base?.stamp ?? binStamp);
    } catch (e) {
      for (const closedRef of closed.values()) openPage(closedRef);
      throw e;
    }
    closeTabsUnder(notebook, path);
    for (const [key, r] of Object.entries(useDocuments.getState().refs)) {
      if (r.notebook === notebook && movedPath(r.path, path, path) !== null) discard(key);
    }
    discardDocxUnder(notebook, path);
    discardPdfUnder(notebook, path);
  } finally {
    done();
  }
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
}

/** The first notebook shown on the Notes page. */
export async function firstNotebook(client: QueryClient): Promise<string | undefined> {
  return (await client.ensureQueryData(notebooksQuery()))[0]?.id;
}

/** Ctrl+N on the Notes page: a new page in the focused page's notebook and folder, else the first notebook shown. */
export async function newPageHere(client: QueryClient) {
  const { notebook, folder } = currentNotebook(await firstNotebook(client));
  // With no notebook yet, Ctrl+N starts an untitled text file (NS-1B).
  if (!notebook) { useWorkspace.getState().openTab({ kind: "new-file" }); return; }
  await newPage(client, notebook, folder).catch((e) => toast(classify(e).message, "error"));
}

/** Make the page a missing `[[link]]` names: a rich page starts as a valid one, any other page is empty. */
export async function createMissingPage(notebook: string, path: string) {
  await createDoc(notebook, path, isRichDoc(path) ? newPageText(pageTitle(path)) : "");
}
