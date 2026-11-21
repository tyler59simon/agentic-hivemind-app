// A code range (NS-3D): lines `from` to `to` of a file of the page's notebook. The page keeps a copy of those lines and
// the SHA-256 of them joined with LF. The block shows the file's current lines and says when their hash is no longer the
// stored one; Update stores the current lines. Everything here is pure; the view and the picker call it.
import { MAX_RANGE_CHARS, MAX_RANGE_LINES } from "../rules";
import { sha256 } from "./hash";

/** The lines of file text (LF line breaks, as the file service reads it). A final line break ends the last line; it does
 *  not start another. */
export function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The hash a range is stored with: its lines joined with LF. */
export const hashLines = (lines: readonly string[]): string => sha256(lines.join("\n"));

export interface Captured { text: string; sha256: string }

/** The range `from` to `to` (1-based, inclusive) of a file's lines as the page stores it, or why it cannot be stored. */
export function captureRange(lines: readonly string[], from: number, to: number): { ok: true; captured: Captured } | { ok: false; reason: string } {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1) return { ok: false, reason: "Line numbers start at 1." };
  if (to < from) return { ok: false, reason: "The last line is before the first." };
  if (to > lines.length) return { ok: false, reason: `The file has ${lines.length} ${lines.length === 1 ? "line" : "lines"}.` };
  if (to - from + 1 > MAX_RANGE_LINES) return { ok: false, reason: `A range holds at most ${MAX_RANGE_LINES} lines.` };
  const chosen = lines.slice(from - 1, to);
  const text = chosen.join("\n");
  if (text.length > MAX_RANGE_CHARS) return { ok: false, reason: `A range holds at most ${MAX_RANGE_CHARS.toLocaleString("en-US")} characters.` };
  return { ok: true, captured: { text, sha256: hashLines(chosen) } };
}

export interface RangeAttrs { from: number; to: number; sha256: string; text: string }

/** What the block shows for the stored range and the file as it is now (`null` when the file cannot be read):
 *  - `missing`: no file, so the stored lines show with a note;
 *  - `past-end`: the file is shorter than the range, so the stored lines show with a note;
 *  - `same`: the file's lines hash to the stored hash;
 *  - `changed`: they do not, and `current` holds the lines Update would store. */
export type RangeState =
  | { kind: "missing" }
  | { kind: "past-end"; lines: number }
  | { kind: "same"; shown: string }
  | { kind: "changed"; shown: string; current: Captured };

export function rangeState(attrs: RangeAttrs, fileText: string | null): RangeState {
  if (fileText === null) return { kind: "missing" };
  const lines = fileLines(fileText);
  if (attrs.to > lines.length) return { kind: "past-end", lines: lines.length };
  const chosen = lines.slice(attrs.from - 1, attrs.to);
  const hash = hashLines(chosen);
  const shown = chosen.join("\n");
  return hash === attrs.sha256 ? { kind: "same", shown } : { kind: "changed", shown, current: { text: shown, sha256: hash } };
}

/** `Update`: the attributes with the current lines and their hash. The range, file and title stay. */
export function updated<T extends RangeAttrs>(attrs: T, current: Captured): T {
  return { ...attrs, text: current.text, sha256: current.sha256 };
}

/** The label of a range: `src/app.ts:12-20`. */
export const rangeLabel = (file: string, from: number, to: number): string => `${file}:${from}${to === from ? "" : `-${to}`}`;
