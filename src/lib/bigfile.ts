// The large file viewer (NS-6B): the commands of src-tauri/src/bigfile.rs. A file is named as every file command names it, by
// a notebook id (or `@<grant>` for a loose file) and a path; Rust gives back a handle that the other calls take.
// Lines are counted from 0 here, and the screen adds 1.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface BigLine { number: number; text: string; /** The line is longer than what is shown. */ cut: boolean }
/** `total` is the lines the index knows so far; `indexed` says it knows them all. */
export interface BigLines { first: number; lines: BigLine[]; total: number; indexed: boolean; size: number }
export interface BigOpened { handle: string; size: number; encoding: string; bom: boolean; binary: boolean; first: BigLines }
/** A match: its line, and its start and end in UTF-16 units of the line as shown. */
export interface BigHit { line: number; start: number; end: number }
export interface BigFound { hit: BigHit | null; /** The search went on from the other end of the file. */ wrapped: boolean; /** A newer search took its place. */ cancelled: boolean }
/** What `bigfile-progress` (indexing) and `bigfile-grew` (the file grew, or `reset`: it was truncated or replaced) tell. */
export interface BigProgress {
  handle: string; scanned: number; size: number; lines: number; done: boolean; reset: boolean;
  /** How the file is read now: after a replacement it can be another encoding. */
  encoding: string; bom: boolean; binary: boolean;
}

export const bigfileOpen = (notebook: string, path: string) => invoke<BigOpened>("bigfile_open", { notebook, path });
export const bigfileLines = (handle: string, first: number, count: number) => invoke<BigLines>("bigfile_lines", { handle, first, count });
/** The next match from `(line, col)`, or the previous one with `forward` false. `regex` false searches the text as typed. */
export const bigfileSearch = (handle: string, pattern: string, regex: boolean, caseSensitive: boolean, line: number, col: number, forward: boolean) =>
  invoke<BigFound>("bigfile_search", { handle, pattern, regex, case: caseSensitive, line, col, forward });
export const bigfileBytes = (handle: string, offset: number, len: number) => invoke<number[]>("bigfile_bytes", { handle, offset, len });
/** Where `needle` starts at or after `offset` (before it, with `forward` false), and whether the search wrapped. */
export const bigfileFindBytes = (handle: string, needle: number[], offset: number, forward: boolean) =>
  invoke<[number | null, boolean]>("bigfile_find_bytes", { handle, needle, offset, forward });
export const bigfileClose = (handle: string) => invoke<void>("bigfile_close", { handle });

/** Listen to indexing progress and growth; returns the function that stops listening. */
export async function onBigfile(callback: (event: "progress" | "grew", progress: BigProgress) => void): Promise<() => void> {
  const stops = await Promise.all([
    listen<BigProgress>("bigfile-progress", (e) => callback("progress", e.payload)),
    listen<BigProgress>("bigfile-grew", (e) => callback("grew", e.payload)),
  ]);
  return () => stops.forEach((stop) => stop());
}

/** The bytes of a hex string such as `de ad be ef`, `DEADBEEF` or `0xde 0xad`; null when it is not hex. */
export function parseHex(text: string): number[] | null {
  const digits = text.replace(/0x/gi, "").replace(/[\s,:-]/g, "");
  if (!digits || digits.length % 2 || !/^[0-9a-f]+$/i.test(digits)) return null;
  return digits.match(/../g)!.map((pair) => parseInt(pair, 16));
}

/** A byte offset typed as `0x1f40`, `1F40h` or decimal `8000`; null when it is not a number. */
export function parseOffset(text: string): number | null {
  const t = text.trim().replace(/[_\s]/g, "");
  const hex = /^0x([0-9a-f]+)$/i.exec(t) ?? /^([0-9a-f]+)h$/i.exec(t);
  if (hex) return parseInt(hex[1], 16);
  return /^\d+$/.test(t) ? parseInt(t, 10) : null;
}
