// Reads and writes of notebook pages, by container: a folder notebook or a loose file, through Rust's file commands. The
// document store, the tree and the page actions call these.
import { invoke } from "@tauri-apps/api/core";
import * as files from "../lib/notebooks";
import type { FileFormat, Stamp } from "../lib/notebooks";
import type { FileRef } from "./keys";

export const readDoc = (ref: FileRef) => files.readFile(ref.notebook, ref.path);

/** The file again, decoded as `encoding`. */
export const reopenDoc = (ref: FileRef, encoding: string) => files.reopenFile(ref.notebook, ref.path, encoding);

/** `source`: what asks for the save, for a file's history. */
export const saveDoc = (ref: FileRef, text: string, pre: Stamp, format: FileFormat, convert = false, source?: string) =>
  files.saveFile(ref.notebook, ref.path, text, pre, format, convert, source);

export const createDoc = (notebook: string, path: string, text: string) => files.createFile(notebook, path, text);

/** A new section: an empty folder. */
export const createSection = (notebook: string, path: string) => files.makeFolder(notebook, path);

export const moveDoc = (notebook: string, from: string, to: string) => files.renameFile(notebook, from, to);

export const deleteDoc = (notebook: string, path: string, pre?: Stamp) => files.deleteFile(notebook, path, pre);

/** A notebook's sections and pages, under the query key the page actions refresh. */
export const treeQuery = (id: string) => ({ queryKey: ["notebook-tree", id], queryFn: () => files.notebookTree(id) });

/** Save a picture as an attachment of a notebook page (NS-3A); resolves to its path from the notebook's root. The
 *  bytes go as the raw request body, the names as percent-encoded headers. */
export const attachBytes = (notebook: string, page: string, name: string, bytes: Uint8Array) => {
  const headers: Record<string, string> = { notebook: encodeURIComponent(notebook), page: encodeURIComponent(page), name: encodeURIComponent(name) };
  return invoke<string>("file_attach_bytes", bytes, { headers });
};

/** Attach the picture at `index` of a drop the same way. */
export const attachDropped = (token: string, index: number, notebook: string, page: string) =>
  invoke<string>("file_attach_dropped", { token, index, notebook, page });
