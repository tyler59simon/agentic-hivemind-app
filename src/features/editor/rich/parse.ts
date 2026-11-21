// Pure parsers for the rich page editor and the reading view (NS-3A): pictures and their width, embeds, callouts and
// footnotes. Everything here works on plain text, so Live and Reading agree.
import { GFM, parser } from "@lezer/markdown";

const headingParser = parser.configure([GFM]);

export const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const isPicture = (path: string) => PICTURE.test(path.replace(/[?#].*$/, ""));

export interface Size { width?: number; height?: number }

/** `alt|300` or `alt|300x200` (Obsidian's width syntax inside the alt text or after a wiki target). */
export function splitSize(text: string): { text: string } & Size {
  const m = /^(.*?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(text);
  if (!m) return { text };
  return { text: m[1].trim(), width: Number(m[2]), ...(m[3] ? { height: Number(m[3]) } : {}) };
}

export type Embed =
  | ({ kind: "picture"; src: string; alt: string; wiki: boolean } & Size)
  | { kind: "page"; target: string; heading?: string; label?: string };

const MD_PICTURE = /^!\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)$/;
const WIKI_EMBED = /^!\[\[([^\]\n]+)\]\]$/;

/** What a `![...](...)` or `![[...]]` source shows, or null when it is neither. A wiki embed of a picture file is a
 *  picture; any other wiki embed is a page (with an optional `#heading`). */
export function parseEmbed(source: string): Embed | null {
  const text = source.trim();
  const md = MD_PICTURE.exec(text);
  if (md) {
    const { text: alt, ...size } = splitSize(md[1]);
    const src = md[2].startsWith("<") ? md[2].slice(1, -1) : md[2];
    return { kind: "picture", src, alt, wiki: false, ...size };
  }
  const wiki = WIKI_EMBED.exec(text);
  if (!wiki) return null;
  const pipe = wiki[1].indexOf("|");
  const target = (pipe >= 0 ? wiki[1].slice(0, pipe) : wiki[1]).trim();
  const after = pipe >= 0 ? wiki[1].slice(pipe + 1).trim() : "";
  if (isPicture(target)) {
    const size = /^\d+(?:x\d+)?$/.test(after) ? splitSize(`|${after}`) : { text: "" };
    return { kind: "picture", src: target, alt: after && !size.width ? after : "", wiki: true, ...(size.width ? { width: size.width } : {}), ...("height" in size && size.height ? { height: size.height } : {}) };
  }
  const hash = target.indexOf("#");
  return {
    kind: "page",
    target: (hash >= 0 ? target.slice(0, hash) : target).trim(),
    ...(hash >= 0 ? { heading: target.slice(hash + 1).trim() } : {}),
    ...(after ? { label: after } : {}),
  };
}

/** The same picture source with its width set (or removed with `null`), in whichever syntax it was written. */
export function withWidth(source: string, width: number | null): string {
  const text = source.trim();
  const md = MD_PICTURE.exec(text);
  const lead = source.slice(0, source.indexOf(text));
  const tail = source.slice(source.indexOf(text) + text.length);
  if (md) {
    const alt = splitSize(md[1]).text;
    const label = width === null ? alt : `${alt}|${Math.round(width)}`;
    // The source is `![` + raw alt + `]` + the destination; only the alt changes.
    return `${lead}![${label}]${text.slice(md[1].length + 3)}${tail}`;
  }
  const wiki = WIKI_EMBED.exec(text);
  if (!wiki) return source;
  const pipe = wiki[1].indexOf("|");
  const target = pipe >= 0 ? wiki[1].slice(0, pipe) : wiki[1];
  return `${lead}![[${target}${width === null ? "" : `|${Math.round(width)}`}]]${tail}`;
}

/** Obsidian's callout types, with their aliases folded onto one name each. */
const CALLOUT_ALIASES: Record<string, string> = {
  summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success",
  help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure",
  error: "danger", cite: "quote",
};
export const CALLOUT_TYPES = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example", "quote"];

export interface Callout { type: string; label: string; fold: "" | "+" | "-"; title: string }

/** The callout a blockquote's first line opens (`> [!warning]- Title`), or null. Unknown types render as notes. */
export function parseCallout(firstLine: string): Callout | null {
  const m = /^\s*>\s*\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/.exec(firstLine);
  if (!m) return null;
  const label = m[1].toLowerCase();
  const type = CALLOUT_ALIASES[label] ?? (CALLOUT_TYPES.includes(label) ? label : "note");
  return { type, label, fold: m[2] as Callout["fold"], title: m[3].trim() || label.charAt(0).toUpperCase() + label.slice(1) };
}

export interface FootnoteRef { id: string; from: number; to: number }

/** `[^id]` references in a line of text (not definitions). */
export function footnoteRefs(text: string): FootnoteRef[] {
  const out: FootnoteRef[] = [];
  for (const m of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) out.push({ id: m[1], from: m.index!, to: m.index! + m[0].length });
  return out;
}

const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

/** Every `[^id]: text` definition of a document, given as lines; a definition's indented lines continue it. */
export function footnoteDefs(lines: Iterable<string>): Map<string, string> {
  const defs = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines) {
    const m = DEFINITION.exec(line);
    if (m) { current = m[1]; defs.set(current, m[2]); continue; }
    if (current && /^( {2,}|\t)\S/.test(line)) { defs.set(current, `${defs.get(current)} ${line.trim()}`); continue; }
    current = null;
  }
  return defs;
}

/** The section of `text` under the heading named `heading` (to the next heading of the same or a higher level), for
 *  `![[Page#Heading]]`; the whole text when there is no heading; null when it is not found. */
export function section(text: string, heading?: string): string | null {
  if (!heading) return text;
  // Headings as Markdown parses them: a `# line` inside a code fence is not one, and Setext headings are (Codex review
  // of 398b956, P3).
  const headings: { level: number; from: number; title: string }[] = [];
  const top = headingParser.parse(text).topNode;
  for (let node = top.firstChild; node; node = node.nextSibling) {
    const m = /^(ATXHeading|SetextHeading)(\d)$/.exec(node.name);
    if (!m) continue;
    const raw = text.slice(node.from, node.to);
    const title = m[1] === "ATXHeading"
      ? raw.replace(/^#{1,6}[ \t]*/, "").replace(/([ \t]+#+)?[ \t]*$/, "")
      : raw.split(/\r?\n/).slice(0, -1).join(" "); // every line before the underline (Codex re-review of 87a0a1f)
    headings.push({ level: Number(m[2]), from: node.from, title: title.replace(/\s+/g, " ").trim() });
  }
  const want = heading.replace(/\s+/g, " ").trim().toLowerCase();
  const start = headings.findIndex((h) => h.title.toLowerCase() === want);
  if (start < 0) return null;
  const next = headings.slice(start + 1).find((h) => h.level <= headings[start].level);
  return text.slice(headings[start].from, next ? next.from : text.length).replace(/\s+$/, "");
}

/** A name for a pasted picture: `Pasted image 20261121135501.png`, from the local time. */
export function pastedName(now: Date, ext = "png"): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Pasted image ${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.${ext}`;
}

/** `path` (from the notebook's root) as seen from `folder` (also from the root): `../` for each folder to climb. */
export function relativePath(folder: string, path: string): string {
  const from = folder ? folder.split("/") : [];
  const to = path.split("/");
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return [...from.slice(same).map(() => ".."), ...to.slice(same)].join("/");
}

/** The Markdown that links an attachment at `path` (relative to the page's folder) under `name`. */
export function attachmentLink(path: string, name: string): string {
  // Parentheses too: Markdown ends a link's destination at the first `)` (Codex review of 398b956, P2).
  const url = path.split("/").map((p) => encodeURIComponent(p).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
  return `${isPicture(path) ? "!" : ""}[${name.replace(/[[\]]/g, "")}](${url})`;
}
