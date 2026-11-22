// Compare two files (NS-6A): the model behind the Compare tab. The side-by-side view is `@codemirror/merge`; what is here
// is what it does not give: ignoring whitespace, moving between changes, copying a change across, and the list of open
// files to pick from. The two sides are "a" (left) and "b" (right).
import { Change, Chunk, diff, type DiffConfig } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { keyOf } from "../../documents/store";
import type { FileRef } from "../../documents/keys";
import { fileName } from "../../lib/notebooks";
import type { Pane } from "../../workspace/store";

export type Side = "a" | "b";

const squash = (line: string) => line.replace(/\s+/g, "");

/** A diff that compares lines with their whitespace removed, so a line whose indentation or spacing changed is the same
 *  line. It gives the changes in text positions, as the editor's own diff does. */
export function ignoreWhitespaceDiff(a: string, b: string): readonly Change[] {
  const linesA = a.split("\n"), linesB = b.split("\n");
  // Every distinct line becomes one character, so the editor's diff can compare whole lines.
  const codes = new Map<string, string>();
  let next = 0x100;
  const encode = (lines: string[]): string | null => {
    let out = "";
    for (const line of lines) {
      const key = squash(line);
      let c = codes.get(key);
      if (c === undefined) {
        if (next >= 0xd800) return null;
        c = String.fromCharCode(next++);
        codes.set(key, c);
      }
      out += c;
    }
    return out;
  };
  const ea = encode(linesA), eb = encode(linesB);
  // More distinct lines than characters to give them: fall back to the exact diff.
  if (ea === null || eb === null) return diff(a, b);
  const starts = (lines: string[]) => { let at = 0; return lines.map((l) => { const s = at; at += l.length + 1; return s; }); };
  const startA = starts(linesA), startB = starts(linesB);
  // The start of line `i`, and the end of the lines before `i` (the end of line `i - 1`, without its break).
  const from = (s: number[], i: number, len: number) => (i < s.length ? s[i] : len);
  const to = (s: number[], lines: string[], i: number) => s[i - 1] + lines[i - 1].length;
  return diff(ea, eb).map((c) => new Change(
    from(startA, c.fromA, a.length),
    c.toA > c.fromA ? to(startA, linesA, c.toA) : from(startA, c.fromA, a.length),
    from(startB, c.fromB, b.length),
    c.toB > c.fromB ? to(startB, linesB, c.toB) : from(startB, c.fromB, b.length),
  ));
}

/** The editor's diff settings: its default, or with whitespace ignored. */
export const diffConfig = (ignoreWhitespace: boolean): DiffConfig => (ignoreWhitespace ? { override: ignoreWhitespaceDiff } : { scanLimit: 500 });

/** The changed chunks between two texts, as the Compare view finds them. */
export const chunksOf = (a: string, b: string, ignoreWhitespace: boolean): readonly Chunk[] =>
  Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")), diffConfig(ignoreWhitespace));

/** The next or previous change after `index` (none yet: the first or the last), wrapping round; null with no changes. */
export function stepChunk(count: number, index: number | null, direction: 1 | -1): number | null {
  if (count === 0) return null;
  if (index === null || index < 0 || index >= count) return direction > 0 ? 0 : count - 1;
  return (index + direction + count) % count;
}

/** The change a position in side `side` is in, or the first one after it; the last when it is past them all. */
export function chunkAt(chunks: readonly Chunk[], side: Side, pos: number): number | null {
  if (!chunks.length) return null;
  const at = chunks.findIndex((c) => pos < (side === "a" ? c.toA : c.toB) || pos <= (side === "a" ? c.fromA : c.fromB));
  return at < 0 ? chunks.length - 1 : at;
}

/** The text side `from`'s version of `chunk` gives the other side: that side's text with the chunk's lines replaced by
 *  `from`'s (as the editor's own revert control does it). */
export function copyHunk(chunk: Chunk, from: Side, a: string, b: string): { to: Side; text: string } {
  const [src, dest, srcFrom, srcTo, destFrom, destTo] = from === "a"
    ? [a, b, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB]
    : [b, a, chunk.fromB, chunk.toB, chunk.fromA, chunk.toA];
  let insert = src.slice(srcFrom, Math.max(srcFrom, srcTo - 1));
  // The copied lines end with a break unless they end the destination too.
  if (srcFrom !== srcTo && destTo <= dest.length) insert += "\n";
  return { to: from === "a" ? "b" : "a", text: dest.slice(0, destFrom) + insert + dest.slice(Math.min(dest.length, destTo)) };
}

/** A file open in a tab, to pick for a comparison. */
export interface Choice { ref: FileRef; key: string; label: string }

/** The files open in tabs, each once, in tab order. */
export function openFiles(panes: Pick<Pane, "tabs">[]): Choice[] {
  const seen = new Set<string>();
  const out: Choice[] = [];
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      if (tab.kind !== "file" || !tab.file) continue;
      const key = keyOf(tab.file);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: tab.file, key, label: tab.title || fileName(tab.file.path) });
    }
  }
  return out;
}

// Keeping the two sides line for line (UI-1) -------------------------------------------------------------------------
// The editor's own merge view measures the page and pads the shorter side with spacers, and it did not hold here. Lines are
// one fixed height (no wrapping, `LINE_PX`), so how much to pad is known from the changes alone, with nothing measured.

/** The height of one line in the Compare view, in pixels; its theme sets it, and a gap is `lines * LINE_PX` tall. */
export const LINE_PX = 20;

/** Empty lines to show on `side`, so that what follows lines up with the other side. `pos` is where the gap goes: above
 *  the line that starts there, or, with `below`, after the last line of the document. */
export interface Gap { side: Side; pos: number; lines: number; below: boolean }

const lineCount = (doc: Text, from: number, to: number) => (to > from ? doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(Math.min(from, doc.length)).number + 1 : 0);

/** The gaps that make every unchanged line sit beside its twin: for each change, the side with fewer lines gets the
 *  difference, after the lines it has there (or where they would be). */
export function alignment(chunks: readonly Chunk[], a: Text, b: Text): Gap[] {
  const gaps: Gap[] = [];
  for (const chunk of chunks) {
    const na = lineCount(a, chunk.fromA, chunk.toA), nb = lineCount(b, chunk.fromB, chunk.toB);
    if (na === nb) continue;
    const side: Side = na < nb ? "a" : "b";
    const doc = side === "a" ? a : b, count = side === "a" ? na : nb;
    const from = side === "a" ? chunk.fromA : chunk.fromB, to = side === "a" ? chunk.toA : chunk.toB;
    const pos = count > 0 ? to : from;
    gaps.push({ side, pos: Math.min(pos, doc.length), lines: Math.abs(na - nb), below: pos > doc.length });
  }
  return gaps;
}
