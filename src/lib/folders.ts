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
