// Where a `[[Page]]` link in a notebook page points, Obsidian style: an exact path, then the same folder, then anywhere
// in the notebook (the shortest path wins). NS-4A widens this to other notebooks and to memory notes.
import type { FileRef } from "../../documents/keys";
import { fileName, folderOf } from "../../lib/notebooks";

export type Resolved = { ref: FileRef } | { missing: string } | { ambiguous: FileRef[] };

const MD = /\.(md|markdown|hmdoc)$/i;
const low = (s: string) => s.toLowerCase();
/** A link names a Markdown page without its extension, or any file with its full name. */
const nameOf = (path: string) => (MD.test(path) ? fileName(path).replace(MD, "") : fileName(path));
const withoutExt = (path: string) => path.replace(MD, "");
const depth = (path: string) => path.split("/").length;
const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** A bare name that both `Plan.md` and `Plan.hmdoc` answer is the Markdown page (R1-6); `[[Plan.hmdoc]]` names the rich one. */
function withoutRichTwins(list: string[], pages: string[], explicit: boolean): string[] {
  if (explicit) return list;
  const markdown = new Set(pages.filter((p) => /\.(md|markdown)$/i.test(p)).map((p) => low(p.replace(/\.(md|markdown)$/i, ""))));
  return list.filter((p) => !(/\.hmdoc$/i.test(p) && markdown.has(low(p.replace(/\.hmdoc$/i, "")))));
}

/** The candidates at the shortest depth: one is the answer, several are a tie for the user to pick. */
function shortest(from: FileRef, hits: string[]): Resolved {
  const least = Math.min(...hits.map(depth));
  const best = hits.filter((p) => depth(p) === least);
  return best.length === 1 ? { ref: { notebook: from.notebook, path: best[0] } } : { ambiguous: best.map((path) => ({ notebook: from.notebook, path })) };
}

export function resolvePage(target: string, from: FileRef, pages: string[]): Resolved {
  const clean = target.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const here = folderOf(from.path);
  const ref = (path: string): Resolved => ({ ref: { notebook: from.notebook, path } });
  const same = (path: string, want: string) => low(path) === low(want) || low(withoutExt(path)) === low(want);
  if (!clean) return { missing: join(here, "Untitled.md") };
  const explicit = /\.hmdoc$/i.test(clean);

  let hits: string[];
  if (clean.includes("/")) {
    // A path: from the notebook root, then from this page's folder, then any page whose path ends with it.
    for (const base of [clean, join(here, clean)]) {
      const [hit] = withoutRichTwins(pages.filter((p) => same(p, base)), pages, explicit);
      if (hit) return ref(hit);
    }
    const tail = `/${low(clean)}`;
    hits = withoutRichTwins(pages.filter((p) => low(p).endsWith(tail) || low(withoutExt(p)).endsWith(tail)), pages, explicit);
  } else {
    const name = low(clean);
    hits = withoutRichTwins(pages.filter((p) => low(nameOf(p)) === name || low(fileName(p)) === name), pages, explicit);
    const near = hits.filter((p) => low(folderOf(p)) === low(here));
    if (near.length) return ref(near[0]);
  }
  if (hits.length) return shortest(from, hits);
  const rel = clean.includes("/") ? clean : join(here, clean);
  return { missing: /\.[a-z0-9]{1,8}$/i.test(rel) ? rel : `${rel}.md` };
}
