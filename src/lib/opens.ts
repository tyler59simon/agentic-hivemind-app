// Files opened from outside the notebook tree (NS-1B). Rust names each one for the webview: a page of the notebook it
// lies in, or a loose file, whose notebook id is `@` and a grant id and whose path is its file name. The webview never
// sends an absolute path.
import { invoke } from "@tauri-apps/api/core";
import type { FileRef } from "../documents/keys";
import type { Notebook } from "./notebooks";

/** A recent loose file, for Ctrl+O. */
export interface Recent { id: string; path: string; name: string; opened: string; exists: boolean }

export const LOOSE = "@";
/** Whether `ref` is a file outside every notebook. */
export const isLoose = (ref: Pick<FileRef, "notebook">) => ref.notebook.startsWith(LOOSE);
/** The ref of a recent loose file. */
export const recentRef = (r: Recent): FileRef => ({ notebook: `${LOOSE}${r.id}`, path: r.name });

export const openDialog = () => invoke<FileRef[]>("open_dialog");
export const openPending = () => invoke<FileRef[]>("open_pending");
export const openRecent = () => invoke<Recent[]>("open_recent");
export const openForget = (id: string) => invoke<void>("open_forget", { id });
/** Save a new text file where the user picks; null when they cancelled. */
export const saveAs = (text: string, suggested: string) => invoke<FileRef | null>("file_save_as", { text, suggested });
/** The URL prefix pictures beside the page load from. */
export const assetBase = (notebook: string, path: string) => invoke<string>("asset_base", { notebook, path });
/** Add a folder dropped on the window as a notebook, by the token Rust gave for it. */
export const addDroppedNotebook = (token: string) => invoke<Notebook>("notebook_add_dropped", { token });

export const recentQuery = () => ({ queryKey: ["open-recent"], queryFn: openRecent });
