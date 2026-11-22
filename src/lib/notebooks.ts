// Folder notebooks: the Tauri commands of src-tauri/src/studio.rs. The webview names a notebook by id and a page by a
// relative, forward-slash path; Rust resolves both, so nothing here ever holds an absolute path it could misuse.
import { invoke } from "@tauri-apps/api/core";
import type { Visibility } from "./lm";

/** `domain`, `visibility` and `private` copy what Living Memory holds for the folder (NS-2C); absent until it was registered there. */
export interface Notebook { id: string; path: string; title: string; added: string; domain?: string; visibility?: Visibility; private?: boolean }
export type EntryKind = "dir" | "page" | "text" | "other";
export interface Entry { path: string; kind: EntryKind; size: number; mtimeMs: number }
export interface Tree { entries: Entry[]; truncated: boolean }

export type Eol = "lf" | "crlf" | "cr" | "mixed" | "none";
/** `encoding` is an encoding_rs name ("UTF-8", "UTF-16LE", "windows-1252", ...); `confidence` says how it was found. */
export interface FileFormat { encoding: string; bom: boolean; eol: Eol; confidence?: "bom" | "valid" | "guess" }
export interface Stamp { sha256: string; size: number; mtimeMs: number }
export interface Loaded extends Stamp { text: string; format: FileFormat; readOnly: string | null; binary: boolean; convertible?: boolean }
export type SaveOutcome = ({ status: "saved" } & Stamp) | { status: "stale"; sha256: string } | { status: "gone" };

/** Settings kept in the notebook's `.hivemind/notebook.json` (README 5.4). Unknown keys are kept by Rust. */
export interface NotebookMeta {
  version?: number;
  order?: Record<string, string[]>;
  icons?: Record<string, string>;
  pinned?: string[];
  // null in a patch removes the key.
  attachments?: string | null;
  templates?: string | null;
  inbox?: string | null;
  [key: string]: unknown;
}

/** The `files-changed` event. */
export interface FilesChanged { notebook: string; paths: string[] }

export const listNotebooks = () => invoke<Notebook[]>("notebooks_list");
/** Opens the native folder dialog; null when the user cancelled. */
export const addNotebook = () => invoke<Notebook | null>("notebook_add");
export const removeNotebook = (id: string) => invoke<void>("notebook_remove", { id });
export const renameNotebook = (id: string, title: string) => invoke<Notebook>("notebook_rename", { id, title });
export const notebookTree = (id: string) => invoke<Tree>("notebook_tree", { id });
export const notebookMeta = (id: string) => invoke<NotebookMeta>("notebook_meta_get", { id });
export const setNotebookMeta = (id: string, patch: NotebookMeta) => invoke<NotebookMeta>("notebook_meta_set", { id, patch });

export const readFile = (notebook: string, path: string) => invoke<Loaded>("file_read", { notebook, path });
/** `convert`: the user chose Convert to UTF-8, so text that does not decode may be replaced. `source` says what asks for
 *  the save, for the page's history (`links`, `restore`, `replace`, `ai`, `agent`); it is the user's own save when left out. */
export const saveFile = (notebook: string, path: string, text: string, pre: Stamp, format: FileFormat, convert = false, source?: string) =>
  invoke<SaveOutcome>("file_save", { notebook, path, text, pre, format, convert, ...(source ? { source } : {}) });
export const createFile = (notebook: string, path: string, text: string) => invoke<Stamp>("file_create", { notebook, path, text });
export const makeFolder = (notebook: string, path: string) => invoke<void>("file_mkdir", { notebook, path });
export const renameFile = (notebook: string, from: string, to: string) => invoke<void>("file_rename", { notebook, from, to });
/** Moves to the notebook's trash; returns where it went. */
export const deleteFile = (notebook: string, path: string, pre?: Stamp) => invoke<string>("file_delete", { notebook, path, pre: pre ?? null });
/** Shows the file in Explorer, or with `open` opens it in the program Windows associates with it. */
export const revealFile = (notebook: string, path: string | null, open = false) => invoke<void>("file_reveal", { notebook, path, open });

export const notebooksQuery = () => ({ queryKey: ["notebooks"], queryFn: listNotebooks });
export const treeQuery = (id: string) => ({ queryKey: ["notebook-tree", id], queryFn: () => notebookTree(id) });
export const metaQuery = (id: string) => ({ queryKey: ["notebook-meta", id], queryFn: () => notebookMeta(id) });

/** Markdown pages get Reading, Live and Source modes; other text files only Source. */
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
export const fileName = (path: string) => path.split("/").pop() ?? path;
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** A rich page (NS-3C): a JSON file of folder notebooks, edited in its own editor with no modes. */
export const isRichDoc = (path: string) => /\.hmdoc$/i.test(path);
/** A page's title: its file name without the Markdown or rich page extension. */
export const pageTitle = (path: string) => fileName(path).replace(/\.(md|markdown|hmdoc)$/i, "");

/** A path from the root of the page's own notebook (NS-3D), checked as the file commands check one: forward slashes, no
 *  empty part, `.` or `..`, no hidden part (so `.git` and `.hivemind` stay out of reach), no character Windows refuses. A
 *  file outside the notebook is copied in first, so an embed never names one. */
export function isNotebookPath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 1024) return false;
  return v.split("/").every((part) =>
    part.length > 0 && part.length <= 240 && !part.startsWith(".") && !/[\\:*?"<>|\u0000-\u001f]/.test(part) && !/[. ]$/.test(part));
}
