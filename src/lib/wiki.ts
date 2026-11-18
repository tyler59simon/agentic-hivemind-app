import { invoke } from "@tauri-apps/api/core";

/** Save a domain's wiki as one HTML file: Rust asks where with a native dialog, has Living Memory write it, and opens it.
 *  Resolves with the saved path, or null when the dialog was cancelled. */
export const exportWiki = (domain: string, archived: boolean) => invoke<string | null>("wiki_export", { domain, archived });
