// Find and replace in files (NS-6B): the commands of src-tauri/src/replace.rs. The scope is a registered notebook (and
// optionally a folder of it) or a folder the user added; the webview never sends a path Rust did not hand out. Paths in the
// results are relative to the scope's folder, forward slashes.
import { invoke } from "@tauri-apps/api/core";

/** A notebook (`notebook`, with `sub`: a folder of it) or a folder the user added (`folder`). */
export interface FindScope { notebook?: string; folder?: string; sub?: string }
export interface FindQuery { pattern: string; regex: boolean; case: boolean; word: boolean; include: string[]; exclude: string[] }
/** One match: its line from 1, the lines it covers as they are, and as they would be after the replace. */
export interface Hunk { index: number; line: number; before: string; after: string }
/** `sha256` is the hash of the text the matches were found in: the precondition of the write. */
export interface FilePreview { path: string; sha256: string; matches: number; hunks: Hunk[] }
export interface Skipped { path: string; why: string }
export interface Preview {
  files: FilePreview[];
  /** Files that match but cannot be changed. */
  skipped: Skipped[];
  matches: number;
  /** The search stopped at 10,000 matches. */
  capped: boolean;
  searched: number;
  binary: number;
  large: number;
}
/** A file to change: the matches (by `index`) the user left ticked. */
export interface Chosen { path: string; sha256: string; hunks: number[] }
export interface Applied { done: { path: string; replaced: number }[]; skipped: Skipped[]; undo: string | null }

/** With no `replacement` the hunks only show the lines found. */
export const replacePreview = (scope: FindScope, query: FindQuery, replacement: string | null) => invoke<Preview>("replace_preview", { scope, query, replacement });
/** `unsaved`: the paths with unsaved edits in a tab, which are never written. */
export const replaceApply = (scope: FindScope, query: FindQuery, replacement: string, files: Chosen[], unsaved: string[]) =>
  invoke<Applied>("replace_apply", { scope, query, replacement, files, unsaved });
export const replaceUndo = (undo: string, unsaved: string[]) => invoke<Applied>("replace_undo", { undo, unsaved });

/** The lines of a glob box as patterns: one per line or separated by commas. */
export const globList = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
