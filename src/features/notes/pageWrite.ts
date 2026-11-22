// Changing one thing in a page from outside its editor (NS-7B): ticking a task in the Tasks list, setting a property from a
// table cell or a board column. The change is made on the page's text as it is now and written against what the list
// was read from, so a page that moved on is refused with a message instead of being guessed at.
//   - A page open in a tab changes through its document session, so unsaved edits are kept (the change is one more edit on
//     top of them). A clean page is saved at once; a page with unsaved edits stays unsaved, like the rest of its edits.
//   - A page that is not open is read, changed and saved against the hash (a folder notebook's page) or revision (a Living
//     Memory page) it was read at.
import type { QueryClient } from "@tanstack/react-query";
import { notFound, pageBody, pageText, parseLm, sha256 } from "../../documents/adapters/lmdoc";
import { readDoc, saveDoc } from "../../documents/io";
import type { FileRef } from "../../documents/keys";
import type { DocState } from "../../documents/session";
import { edit, inOwnStore, keyOf, save, useDocuments } from "../../documents/store";
import { docRead, docWrite, LmError } from "../../lib/lm";
import { INDEX_KEY } from "../../lib/noteindex";

export interface PageChange {
  ref: FileRef;
  /** The hash (folder notebook) or revision (Living Memory) of the page when what is being changed was read. A page whose
   *  hash differs is refused. Tasks of a Living Memory page carry none: the line is checked instead. */
  expected?: string;
  /** The new text for the page's text (LF line endings), or null when what the change is about is no longer there. */
  change: (text: string) => string | null;
}

/** What happened to a page: written, or changed in an open page that has unsaved edits and so stays unsaved. */
export type Written = "saved" | "unsaved";

const MOVED = "changed since it was read, so nothing was written";
const gone = (path: string) => new Error(`${path} ${MOVED}: what you changed is no longer there. The list was refreshed`);
const stale = (path: string) => new Error(`${path} ${MOVED}. The list was refreshed`);

export async function changePage({ ref, expected, change }: PageChange): Promise<Written> {
  const key = keyOf(ref);
  const open = useDocuments.getState().docs[key];
  if (open) return changeOpen(ref, key, open, expected, change);
  const lm = parseLm(ref.notebook);
  if (lm) {
    const page = await docRead(lm.domain, lm.notebook, ref.path).catch((e) => {
      throw notFound(e) ? new Error(`${ref.path} is no longer there`) : e;
    });
    if (page.truncated) throw new Error(`${ref.path} is too long for Hivemind to change: Living Memory gave only the start of it, and writing it back would drop the rest. Nothing was written`);
    const { text, format, readOnly } = pageText(page.text);
    if (readOnly || (await sha256(page.text)) !== page.revision) throw new Error(`${ref.path} cannot be edited here: ${readOnly ?? "it holds bytes that are not UTF-8"}. Nothing was written`);
    if (expected && page.revision !== expected) throw stale(ref.path);
    const next = change(text);
    if (next === null) throw gone(ref.path);
    try {
      await docWrite(lm.domain, lm.notebook, ref.path, pageBody(next, format), page.revision);
    } catch (e) {
      throw e instanceof LmError && e.stale ? stale(ref.path) : e;
    }
    return "saved";
  }
  const loaded = await readDoc(ref);
  if (loaded.readOnly || loaded.binary) throw new Error(`${ref.path} cannot be edited here: ${loaded.readOnly ?? "it is not a text file"}. Nothing was written`);
  if (expected && loaded.sha256 !== expected) throw stale(ref.path);
  const next = change(loaded.text);
  if (next === null) throw gone(ref.path);
  const out = await saveDoc(ref, next, { sha256: loaded.sha256, size: loaded.size, mtimeMs: loaded.mtimeMs }, loaded.format);
  if (out.status === "stale") throw stale(ref.path);
  if (out.status === "gone") throw new Error(`${ref.path} is no longer there`);
  return "saved";
}

async function changeOpen(ref: FileRef, key: string, doc: DocState, expected: string | undefined, change: (text: string) => string | null): Promise<Written> {
  if (!inOwnStore(key)) throw new Error(`${ref.path} belongs to another Living Memory store, so it was not changed`);
  if ((doc.status !== "clean" && doc.status !== "dirty") || !doc.base) {
    const why = doc.status === "readOnly" ? "is read-only" : doc.status === "stale" ? "has edits that conflict with the file; resolve them first" : "is busy; try again in a moment";
    throw new Error(`${ref.path} is open and ${why}, so it was not changed`);
  }
  // What the open page was last known to hold on disk is what the list has to match.
  if (expected && doc.base.stamp.sha256 !== expected) throw stale(ref.path);
  const next = change(doc.text);
  if (next === null) throw gone(ref.path);
  if (next === doc.text) return doc.status === "clean" ? "saved" : "unsaved";
  const clean = doc.status === "clean";
  edit(key, next, true);
  if (!clean) return "unsaved";
  const after = await save(key);
  if (after?.status !== "clean") throw new Error(after?.status === "stale" ? stale(ref.path).message : `${ref.path} could not be saved${after?.error ? `: ${after.error}` : ""}. The change is in the open page`);
  return "saved";
}

/** Ask every list that reads pages again, now and once more after the index has had a moment to read the saved page. */
export function refreshLists(client: QueryClient) {
  const now = () => {
    for (const key of [[INDEX_KEY], ["lm-tasks"], ["lm-query"], ["lm-actions"]]) client.invalidateQueries({ queryKey: key });
  };
  now();
  setTimeout(now, 700);
}
