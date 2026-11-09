// Three-way merge for a save that went stale: base (as opened), mine (unsaved edits), theirs (saved now).
import { merge } from "node-diff3";
import type { Fields } from "./save";

export const MINE = "Your edit";
export const THEIRS = "Saved version";

/** Line-based merge of the body; conflicts are left as <<<<<<< / ======= / >>>>>>> blocks. */
export function mergeBody(base: string, mine: string, theirs: string): { text: string; conflicts: number } {
  const lines = (s: string) => s.replace(/\r\n/g, "\n").split("\n");
  const out = merge(lines(mine), lines(base), lines(theirs), { label: { a: MINE, b: THEIRS } });
  const text = out.result.join("\n");
  return { text, conflicts: out.result.filter((l) => String(l).startsWith("<<<<<<<")).length };
}

export const hasConflictMarkers = (text: string) => /^(<{7}|={7}|>{7})( |$)/m.test(text);

type Key = Exclude<keyof Fields, "body">;
const KEYS: Key[] = ["title", "type", "tags", "context", "review_by", "files"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Per property: whichever side changed wins; when both changed it differently, the user picks. */
export function mergeFields(base: Fields, mine: Fields, theirs: Fields) {
  const merged = { ...theirs } as Fields;
  const conflicts: Key[] = [];
  for (const key of KEYS) {
    const [b, m, t] = [base[key], mine[key], theirs[key]];
    if (same(m, t) || same(m, b)) (merged as unknown as Record<Key, unknown>)[key] = t;
    else if (same(t, b)) (merged as unknown as Record<Key, unknown>)[key] = m;
    else conflicts.push(key);
  }
  const body = mergeBody(base.body, mine.body, theirs.body);
  merged.body = body.text;
  return { merged, conflicts, bodyConflicts: body.conflicts };
}
