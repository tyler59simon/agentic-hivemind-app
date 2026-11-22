// Links that follow a page when it is renamed or moved (NS-4A). `mapLinks` finds the links of a Markdown page the way the
// index does (`src-tauri/src/notes_index/links.rs`): `[[wiki]]` and `[text](path)`, never inside code or a frontmatter
// block. `planRewrite` works out, before the move, which links reach the moved pages and what each one must say
// afterwards; `applyPlan` writes them, page by page, each only while it still has the bytes the index read.
import { fromMarkdown } from "mdast-util-from-markdown";
import { movedPath, type FileRef } from "../../documents/keys";
import { fileName, folderOf, isRichDoc, type Loaded, type SaveOutcome, type Stamp, type FileFormat } from "../../lib/notebooks";
import type { IncomingLink } from "../../lib/noteindex";
import { pagePart, resolveWritten, samePage, type PageEnv } from "./resolve";

const low = (s: string) => s.toLowerCase();
const EXTERNAL = /^[a-z][a-z0-9+.-]+:/i;
const stripMd = (path: string) => path.replace(/\.(md|markdown)$/i, "");

function decode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}
/** A path as it is written in a Markdown link: spaces and parentheses escaped, nothing else changed. */
const encodePath = (path: string) => path.replace(/[ ()%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** What `mapLinks` shows a callback: a link's kind and its page part (decoded for a Markdown link). */
export interface WrittenLink { kind: "wiki" | "md"; page: string }

const WIKI = /(!?)\[\[([^\]\n]*)\]\]/g;
const MARKDOWN = /(?<!!)(\[[^\]\n]*\]\()(?:<([^>\n]*)>|([^)\s]*))((?:\s+(?:"[^"]*"|'[^']*'))?\s*\))/g;

/** One line's links, outside its inline code. */
function mapLine(line: string, fn: (link: WrittenLink) => string | null): string {
  // Even pieces are text, odd pieces are code spans (with their backticks).
  const pieces = line.split(/(`+[^`]*?`+)/g);
  return pieces.map((piece, i) => (i % 2 ? piece : mapText(piece, fn))).join("");
}

function mapText(text: string, fn: (link: WrittenLink) => string | null): string {
  const wiki = text.replace(WIKI, (whole, bang: string, inner: string) => {
    // `\|` is how a table cell holds the alias separator.
    const cut = /\\?\|/.exec(inner);
    const target = cut ? inner.slice(0, cut.index) : inner;
    const tail = cut ? inner.slice(cut.index) : "";
    const lead = /^\s*/.exec(target)![0];
    const t = target.slice(lead.length);
    const mark = t.search(/[#^]/);
    const head = mark < 0 ? t : t.slice(0, mark);
    const suffix = mark < 0 ? "" : t.slice(mark);
    const page = head.trimEnd();
    if (!page) return whole;
    const next = fn({ kind: "wiki", page });
    return next === null ? whole : `${bang}[[${lead}${next}${head.slice(page.length)}${suffix}${tail}]]`;
  });
  return wiki.replace(MARKDOWN, (whole, open: string, angled: string | undefined, plain: string | undefined, rest: string) => {
    const dest = angled ?? plain ?? "";
    const mark = dest.search(/[#?]/);
    const path = mark < 0 ? dest : dest.slice(0, mark);
    const suffix = mark < 0 ? "" : dest.slice(mark);
    const page = decode(path);
    if (!page || EXTERNAL.test(decode(dest))) return whole;
    const next = fn({ kind: "md", page });
    if (next === null) return whole;
    // Inside angle brackets a space is allowed as it is; outside them it is escaped.
    return angled === undefined ? `${open}${encodePath(next)}${suffix}${rest}` : `${open}<${next}${suffix}>${rest}`;
  });
}

/** The lines of `body` (0-based) that CommonMark reads as code: fenced or indented blocks, also inside a quote or a list item.
 *  A link written there is an example, not a link (Codex review of 7320d7f, NOTES-5). */
function codeLines(body: string): Set<number> {
  const found = new Set<number>();
  const walk = (node: { type: string; position?: { start: { line: number }; end: { line: number } }; children?: unknown[] }) => {
    if (node.type === "code" && node.position) {
      for (let line = node.position.start.line; line <= node.position.end.line; line++) found.add(line - 1);
      return;
    }
    (node.children as (typeof node)[] | undefined)?.forEach(walk);
  };
  try { walk(fromMarkdown(body)); } catch { /* the fence tracking in `mapLinks` still holds */ }
  return found;
}

/** `text` with every link `fn` answers for rewritten: it gets the link's kind and page part and returns the new page
 *  part, or null to leave the link. Headings, aliases and titles stay as they were. */
export function mapLinks(text: string, fn: (link: WrittenLink) => string | null): string {
  const lines = text.split("\n");
  let start = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) start = end + 1;
  }
  const code = codeLines(lines.slice(start).join("\n"));
  let fence: { ch: string; size: number } | null = null;
  for (let i = start; i < lines.length; i++) {
    const found = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (found) {
      const [ch, size] = [found[1][0], found[1].length];
      if (!fence) { fence = { ch, size }; continue; }
      if (fence.ch === ch && size >= fence.size && !found[2].trim()) { fence = null; continue; }
    }
    if (!fence && !code.has(i - start)) lines[i] = mapLine(lines[i], fn);
  }
  return lines.join("\n");
}

/** The links of a rich page's JSON (`wikiLink` and `embed` nodes), rewritten the same way; null when it is not a rich page. */
export function mapRichLinks(text: string, fn: (link: WrittenLink) => string | null): string | null {
  let file: { content?: unknown };
  try { file = JSON.parse(text); } catch { return null; }
  if (!file || typeof file !== "object" || !file.content) return null;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; attrs?: { value?: unknown }; content?: unknown[] };
    if ((n.type === "wikiLink" || n.type === "embed") && typeof n.attrs?.value === "string") {
      const [target, ...alias] = n.attrs.value.split("|");
      const mark = target.search(/[#^]/);
      const page = (mark < 0 ? target : target.slice(0, mark)).trim();
      const next = page ? fn({ kind: "wiki", page }) : null;
      if (next !== null) n.attrs.value = [next + (mark < 0 ? "" : target.slice(mark)), ...alias].join("|");
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(file.content);
  return JSON.stringify(file, null, 2) + (text.endsWith("\n") ? "\n" : "");
}

// ---- the plan --------------------------------------------------------------------------------------------------------

/** What to write in place of one link target in one page. */
export interface LinkFix { kind: "wiki" | "md"; from: string; to: string }
export interface PageFix {
  notebook: string;
  /** Where the page is once the move is done. */
  path: string;
  /** The page's hash when the index read it: the page is written only while it still has it. */
  sha256: string;
  fixes: LinkFix[];
  /** Links in the page that must change. */
  links: number;
}
/** A link that reaches a moved page and cannot be rewritten by Hivemind: a canvas card, or a form that no spelling fits. */
export interface Stuck { notebook: string; path: string; raw: string; why: string }
export interface Plan { notebook: string; from: string; to: string; pages: PageFix[]; stuck: Stuck[] }

/** `path` as a Markdown link from a page in `folder`. */
function relativeTo(folder: string, path: string): string {
  const down = path.split("/"), up = folder ? folder.split("/") : [];
  let common = 0;
  while (common < up.length && common < down.length - 1 && low(up[common]) === low(down[common])) common++;
  return [...up.slice(common).map(() => ".."), ...down.slice(common)].join("/");
}

const editable = (path: string) => /\.(md|markdown|hmdoc)$/i.test(path);

/** What a link that no longer reaches `moved` must say, tried the way the old one was written first; null when no
 *  spelling of the new page reaches it from `source`. */
function respell(c: IncomingLink, source: FileRef, moved: FileRef, after: PageEnv): string | null {
  const reaches = (target: string) => {
    const hit = resolveWritten({ raw: target, kind: c.kind }, source, after);
    return "ref" in hit && samePage(hit.ref, moved);
  };
  if (c.kind === "file") return moved.path;
  if (c.kind === "md") {
    const plain = relativeTo(folderOf(source.path), moved.path);
    const candidates = [/^\.\//.test(c.raw) ? `./${plain}` : plain, `/${moved.path}`];
    return candidates.find(reaches) ?? null;
  }
  const old = pagePart(c.raw);
  const title = after.notebooks.find((n) => n.id === moved.notebook)?.title;
  const path = stripMd(moved.path);
  const stem = fileName(path).replace(/\.hmdoc$/i, "");
  // A link that wrote the extension keeps writing it.
  const kept = /\.(md|markdown|hmdoc)$/i.test(old);
  const named = kept ? [fileName(moved.path), stem, `${stem}.hmdoc`] : [stem, `${stem}.hmdoc`, fileName(moved.path)];
  const forms = [...named, path, moved.path];
  const prefixed = title ? (kept ? [`${title}/${moved.path}`, `${title}/${path}`] : [`${title}/${path}`, `${title}/${moved.path}`]) : [];
  const rooted = kept ? [moved.path, path] : [path, moved.path];
  const wrote = old.includes("/") ? [...rooted, ...named] : named;
  // A link from another notebook, or one that named the notebook, keeps naming it.
  const outside = source.notebook !== moved.notebook || (title && low(old).startsWith(`${low(title)}/`));
  const order = outside ? [...prefixed, ...wrote, ...forms] : [...wrote, ...forms, ...prefixed];
  return order.find((t) => t && reaches(t)) ?? null;
}

/** The links that point at the pages moved by renaming `from` to `to` in `notebook`, and what each must say after the move.
 *  `moved` lists the pages before the move (one page, or every page under a folder); `incoming` the links the index holds
 *  whose target is named like one of them; `env` is the world before the move. */
export function planRewrite(args: { notebook: string; from: string; to: string; moved: string[]; incoming: IncomingLink[]; env: PageEnv }): Plan {
  const { notebook, from, to, moved, incoming, env } = args;
  const move = (path: string) => movedPath(path, from, to) ?? path;
  const after: PageEnv = { ...env, pagesOf: (id) => (id === notebook ? env.pagesOf(id)?.map(move) : env.pagesOf(id)) };
  const movedSet = new Set(moved.map(low));
  const pages = new Map<string, PageFix>();
  const stuck: Stuck[] = [];
  for (const c of incoming) {
    const source: FileRef = { notebook: c.notebook, path: c.path };
    const hit = resolveWritten(c, source, env);
    if (!("ref" in hit) || hit.ref.notebook !== notebook || !movedSet.has(low(hit.ref.path))) continue;
    const at: FileRef = c.notebook === notebook ? { notebook, path: move(c.path) } : source;
    const target: FileRef = { notebook, path: move(hit.ref.path) };
    const now = resolveWritten(c, at, after);
    if ("ref" in now && samePage(now.ref, target)) continue;
    if (!editable(c.path)) { stuck.push({ notebook: c.notebook, path: at.path, raw: c.raw, why: "Hivemind does not rewrite links in this kind of page" }); continue; }
    const next = respell(c, at, target, after);
    if (next === null) { stuck.push({ notebook: c.notebook, path: at.path, raw: c.raw, why: "no way of writing the link reaches the page again" }); continue; }
    const key = `${c.notebook}\n${at.path}`;
    const entry = pages.get(key) ?? { notebook: c.notebook, path: at.path, sha256: c.sha256, fixes: [], links: 0 };
    entry.links++;
    const old = c.kind === "wiki" ? pagePart(c.raw) : decode(c.raw.split(/[#?]/)[0]);
    if (!entry.fixes.some((f) => f.kind === (c.kind === "wiki" ? "wiki" : "md") && f.from === old)) entry.fixes.push({ kind: c.kind === "wiki" ? "wiki" : "md", from: old, to: next });
    pages.set(key, entry);
  }
  return { notebook, from, to, pages: [...pages.values()], stuck };
}

/** A page's text with the plan's links for it rewritten. */
export function rewriteText(path: string, text: string, fixes: LinkFix[]): string | null {
  const answer = (link: WrittenLink) => fixes.find((f) => f.kind === link.kind && (f.from === link.page || (link.kind === "wiki" && low(f.from) === low(link.page))))?.to ?? null;
  return isRichDoc(path) ? mapRichLinks(text, answer) : mapLinks(text, answer);
}

// ---- applying it -----------------------------------------------------------------------------------------------------

export interface Skipped { page: PageFix; why: string }
export interface Applied { updated: PageFix[]; skipped: Skipped[] }

export interface PageIo {
  read: (notebook: string, path: string) => Promise<Loaded>;
  save: (notebook: string, path: string, text: string, pre: Stamp, format: FileFormat) => Promise<SaveOutcome>;
  /** Whether an open tab holds unsaved edits of the page. */
  unsaved: (notebook: string, path: string) => boolean;
  /** Called after a page was written, so open tabs show it. */
  written: (notebook: string, path: string) => void;
}

/** Write the plan page by page. A page changed since the index read it, edited in a tab, or unreadable is skipped and
 *  reported; nothing is written over a version the plan was not made from. */
export async function applyPlan(plan: Plan, io: PageIo): Promise<Applied> {
  const out: Applied = { updated: [], skipped: [] };
  for (const page of plan.pages) {
    const skip = (why: string) => out.skipped.push({ page, why });
    try {
      if (io.unsaved(page.notebook, page.path)) { skip("it has unsaved edits in a tab"); continue; }
      const loaded = await io.read(page.notebook, page.path);
      if (loaded.binary || loaded.readOnly) { skip(loaded.readOnly ?? "it is not a text file"); continue; }
      if (loaded.sha256 !== page.sha256) { skip("it changed after Hivemind read it"); continue; }
      const next = rewriteText(page.path, loaded.text, page.fixes);
      if (next === null) { skip("it is not a page Hivemind can rewrite"); continue; }
      if (next === loaded.text) { skip("its links already say what they should"); continue; }
      const done = await io.save(page.notebook, page.path, next, { sha256: loaded.sha256, size: loaded.size, mtimeMs: loaded.mtimeMs }, loaded.format);
      if (done.status === "saved") { out.updated.push(page); io.written(page.notebook, page.path); }
      else skip(done.status === "stale" ? "it changed while the links were written" : "it was deleted");
    } catch (e) {
      skip(String(e instanceof Error ? e.message : e));
    }
  }
  return out;
}

