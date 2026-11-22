// Where a `[[Page]]` link in a notebook page points, Obsidian style: an exact path, then the same folder, then anywhere
// in the notebook (the shortest path wins). `resolveLink` (NS-4A) widens this to other notebooks and to memory notes.
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

// ---- across notebooks and memory (NS-4A) ------------------------------------------------------------------------------
//
// A link is tried in this order: the page's own notebook (`resolvePage`); then the other notebooks, where
// `[[Notebook/Page]]` names a notebook by its title in the first part and a bare name or a path is looked for in every
// notebook; then memory notes by exact title. `[[mem:Title]]` names a memory note directly. Several equal answers are
// a tie for the user to pick, and the pick is written back as the explicit form, which no other page can answer.

export interface MemoryNote { ref: string; title: string; domain: string }

/** What a link may point at besides the page's own notebook. */
export interface PageEnv {
  /** Folder notebooks, in the order shown. */
  notebooks: { id: string; title: string }[];
  /** The page paths of a notebook, or undefined when they are not known. */
  pagesOf: (notebook: string) => string[] | undefined;
  memory: MemoryNote[];
}

/** One answer of a tie. `explicit` is the link target that names it and nothing else. */
export interface Choice {
  label: string;
  detail?: string;
  explicit: string;
  open: { ref: FileRef } | { note: MemoryNote };
}

export type Linked =
  | { ref: FileRef }
  | { note: MemoryNote }
  | { missing: string }
  | { ambiguous: Choice[] }
  /** A `[[mem:Title]]` that names no memory note. */
  | { absent: string };

const MEM = /^mem:\s*/i;
const stripMd = (path: string) => path.replace(/\.(md|markdown)$/i, "");

const pageChoice = (ref: FileRef, title: string | null): Choice => ({
  label: title === null ? ref.path : `${title} / ${ref.path}`,
  explicit: title === null ? stripMd(ref.path) : `${title}/${stripMd(ref.path)}`,
  open: { ref },
});

const noteChoice = (note: MemoryNote): Choice => ({ label: note.title, detail: `Memory note in ${note.domain}`, explicit: `mem:${note.title}`, open: { note } });

/** The page part of a link target: without its `#heading` or `^block` and without an alias. */
export const pagePart = (target: string) => target.split("|")[0].split(/[#^]/)[0].trim();

function memoryAnswer(title: string, env: PageEnv): Linked | null {
  const hits = env.memory.filter((n) => low(n.title.trim()) === low(title));
  if (hits.length === 1) return { note: hits[0] };
  return hits.length > 1 ? { ambiguous: hits.map(noteChoice) } : null;
}

/** Where `[[target]]` in the page `from` points. `own` is the page's own notebook's file list when the caller has a
 *  better one than the index's (the notebook tree lists every file, the index only pages). */
export function resolveLink(target: string, from: FileRef, env: PageEnv, own?: string[]): Linked {
  const clean = pagePart(target) || target.trim();
  const named = MEM.exec(clean);
  if (named) {
    const title = clean.slice(named[0].length).trim();
    return memoryAnswer(title, env) ?? { absent: `No memory note is called ${title}` };
  }
  const here = resolvePage(clean, from, own ?? env.pagesOf(from.notebook) ?? []);
  if ("ref" in here) return here;
  if ("ambiguous" in here) return { ambiguous: here.ambiguous.map((r) => pageChoice(r, null)) };

  const others = env.notebooks.filter((n) => n.id !== from.notebook);
  const path = clean.replace(/\\/g, "/").replace(/^\/+/, "");
  const found: Choice[] = [];
  const look = (nb: { id: string; title: string }, wanted: string) => {
    const pages = env.pagesOf(nb.id);
    if (!pages) return;
    const hit = resolvePage(wanted, { notebook: nb.id, path: "" }, pages);
    if ("ref" in hit) found.push(pageChoice(hit.ref, nb.title));
    else if ("ambiguous" in hit) found.push(...hit.ambiguous.map((r) => pageChoice(r, nb.title)));
  };
  const [first, ...rest] = path.split("/");
  if (rest.length) for (const nb of others.filter((n) => low(n.title) === low(first))) look(nb, rest.join("/"));
  if (!found.length) for (const nb of others) look(nb, path);
  if (found.length === 1) return { ref: (found[0].open as { ref: FileRef }).ref };
  if (found.length > 1) return { ambiguous: found };

  return memoryAnswer(clean, env) ?? here;
}

/** The page a Markdown link's path names, relative to the page that holds it (or to the notebook's root). */
export function resolveHref(href: string, from: FileRef, pages: string[]): FileRef | null {
  const path = href.split(/[#?]/)[0].replace(/\\/g, "/");
  if (!path) return null;
  const parts: string[] = [];
  for (const part of join(folderOf(from.path), path).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (!parts.pop()) return null; } else parts.push(part);
  }
  const wanted = parts.join("/");
  const hit = pages.find((p) => low(p) === low(wanted)) ?? pages.find((p) => low(p) === low(path.replace(/^\/+/, "")));
  return hit ? { notebook: from.notebook, path: hit } : null;
}

/** Where one link a page wrote points, whatever way it was written: `wiki` for `[[Page]]`, `md` for `[text](path)`, `file`
 *  for a canvas card (a path from the notebook's root). */
export function resolveWritten(link: { raw: string; kind: string }, from: FileRef, env: PageEnv, own?: string[]): Linked {
  if (link.kind === "wiki") return resolveLink(link.raw, from, env, own);
  const pages = own ?? env.pagesOf(from.notebook) ?? [];
  // A canvas card names its file from the notebook's root.
  const base = link.kind === "file" ? { ...from, path: "" } : from;
  const hit = resolveHref(link.raw, base, pages);
  if (hit) return { ref: hit };
  return { missing: join(folderOf(base.path), link.raw.split(/[#?]/)[0]) };
}

/** Whether two references name the same page (paths compare ignoring letter case, as the notebook's folder may). */
export const samePage = (a: FileRef, b: FileRef) => a.notebook === b.notebook && low(a.path) === low(b.path);
