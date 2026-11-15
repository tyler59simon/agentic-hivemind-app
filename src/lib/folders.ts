// Folders outside any project. A folder path enters the app only through the native folder picker in Rust; the webview
// can read the list (through the settings) but never add a path to it.
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./lm";

/** Show the system folder dialog. Resolves to the chosen folder, remembered by Hivemind, or null when cancelled. */
export const folderPick = () => invoke<string | null>("folder_pick");
/** Take a folder out of the remembered list. */
export const folderForget = (path: string) => invoke<void>("folder_forget", { path });
/** The remembered folders, oldest first. */
export const otherFolders = async (): Promise<string[]> => (await getSettings()).other_folders ?? [];

/** The project picker's "Other folders" entry. It is a value of the store's `project`, never a real project slug. */
export const OTHER_FOLDERS = "~other";

/** The project slug to use for Living Memory and project pages: null for "All memory", "Other folders" and not picked yet. */
export const realProject = (slug: string | null | undefined): string | null => (slug && slug !== OTHER_FOLDERS ? slug : null);

const normPath = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
/** True when two folder paths name the same folder: slashes, a trailing slash and letter case are ignored (Windows). */
export const samePath = (a: string, b: string) => normPath(a) === normPath(b);
