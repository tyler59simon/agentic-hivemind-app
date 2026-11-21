// Reads and writes of notebook pages, by container (NS-2C): a Living Memory notebook (`lm:<domain>:<notebook>`) goes
// through the `doc` commands, a folder notebook or a loose file through Rust's file commands. The document store, the
// tree and the page actions call these, so they work the same for both kinds.
import { invoke } from "@tauri-apps/api/core";
import { bridgeGeneration } from "../lib/lm";
import * as files from "../lib/notebooks";
import type { FileFormat, Stamp } from "../lib/notebooks";
import * as lmdoc from "./adapters/lmdoc";
import type { FileRef } from "./keys";

export const readDoc = (ref: FileRef) => {
  const lm = lmdoc.parseLm(ref.notebook);
  return lm ? lmdoc.readPage(lm, ref.path) : files.readFile(ref.notebook, ref.path);
};

export const saveDoc = (ref: FileRef, text: string, pre: Stamp, format: FileFormat, convert = false) => {
  const lm = lmdoc.parseLm(ref.notebook);
  return lm ? lmdoc.savePage(lm, ref.path, text, pre, format) : files.saveFile(ref.notebook, ref.path, text, pre, format, convert);
};

/** `format` keeps a Living Memory page's line endings and byte order mark; Rust's `file_create` writes UTF-8 as given. */
export const createDoc = (notebook: string, path: string, text: string, format?: FileFormat) => {
  const lm = lmdoc.parseLm(notebook);
  return lm ? lmdoc.createPage(lm, path, text, format) : files.createFile(notebook, path, text);
};

/** A new section. Living Memory keeps no empty sections, so there it is made with its first page; returns that page,
 *  or null for a folder notebook's empty folder. */
export async function createSection(notebook: string, path: string): Promise<string | null> {
  if (!lmdoc.isLm({ notebook })) { await files.makeFolder(notebook, path); return null; }
  const page = `${path}/Untitled.md`;
  await createDoc(notebook, page, "");
  return page;
}

/** `at`: for a Living Memory page, the bridge generation the action began in (R3-D1). */
export const moveDoc = (notebook: string, from: string, to: string, at?: number) =>
  lmdoc.isLm({ notebook }) ? lmdoc.movePage(notebook, from, to, at) : files.renameFile(notebook, from, to);

export const deleteDoc = (notebook: string, path: string, pre?: Stamp, at?: number) => {
  const lm = lmdoc.parseLm(notebook);
  return lm ? lmdoc.deletePage(lm, path, pre, at) : files.deleteFile(notebook, path, pre);
};

/** A notebook's sections and pages, under the query key the page actions refresh. */
export const treeQuery = (id: string) => ({
  queryKey: ["notebook-tree", id],
  queryFn: () => { const lm = lmdoc.parseLm(id); return lm ? lmdoc.pageTree(lm) : files.notebookTree(id); },
});

/** The attachments of a Living Memory notebook (`assets/<sha8>-<name>`), for `![[picture.png]]`. */
export const lmAssets = (notebook: string) => invoke<string[]>("lmdoc_assets", { notebook });

/** Save a picture as an attachment of a notebook page (NS-3A); resolves to its path from the notebook's root. The
 *  bytes go as the raw request body, the names as percent-encoded headers. */
export const attachBytes = (notebook: string, page: string, name: string, bytes: Uint8Array) => {
  const generation = bridgeGeneration();
  const headers: Record<string, string> = { notebook: encodeURIComponent(notebook), page: encodeURIComponent(page), name: encodeURIComponent(name) };
  if (generation !== undefined) headers.generation = String(generation);
  return invoke<string>("file_attach_bytes", bytes, { headers });
};

/** Attach the picture at `index` of a drop the same way. */
export const attachDropped = (token: string, index: number, notebook: string, page: string) =>
  invoke<string>("file_attach_dropped", { token, index, notebook, page, generation: bridgeGeneration() ?? null });
