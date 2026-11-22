// Versions of a file (NS-5): Rust's `history.rs` keeps one at every save, and for a file inside a git work tree asks git
// for the commits that touched it. A file is named as every file command names it: a notebook id (or `@<grant>` for a
// loose file) and a path.
import { invoke } from "@tauri-apps/api/core";

/** A version Hivemind kept. `time` is milliseconds since the epoch. `source` is what saved it: `you`, `links` (a link
 *  update), `restore`, `replace` (replace in files), `ai`, `agent`; `disk` is a version found on disk that Hivemind did
 *  not write, and `recovered` one rebuilt after the index was damaged. */
export interface Snapshot { id: number; time: number; sha256: string; size: number; source: string; pinned: boolean }
export interface Listing { entries: Snapshot[]; tooLarge: boolean }
/** A commit that touched the file; `path` is the file's path in the repository at that commit. */
export interface GitCommit { sha: string; author: string; date: string; subject: string; path: string }
/** `repo` is null when the file is not inside a git work tree. `changed`: it differs from the last commit. */
export interface GitLog { repo: string | null; commits: GitCommit[]; changed: boolean }
/** A version's text with LF line breaks. `readOnly` says why it cannot be restored as text. */
export interface Version { text: string; binary: boolean; readOnly: string | null; size: number }

export const historyList = (notebook: string, path: string) => invoke<Listing>("history_list", { notebook, path });
/** `id`: a snapshot's number as text, or `git:<commit>`. */
export const historyRead = (notebook: string, path: string, id: string) => invoke<Version>("history_read", { notebook, path, id });
export const historyPin = (notebook: string, path: string, id: number, pinned: boolean) => invoke<void>("history_pin", { notebook, path, id, pinned });
export const gitFileLog = (notebook: string, path: string) => invoke<GitLog>("git_file_log", { notebook, path });
/** Commits this file alone and returns the commit's id. Never pushes. */
export const gitFileCommit = (notebook: string, path: string, message: string) => invoke<string>("git_file_commit", { notebook, path, message });
