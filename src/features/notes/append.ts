// Adding a line to a notebook page (NS-7A): Quick capture's "Today's page" and "Inbox" targets. Rust's `append::insert_under`
// does it for folder notebooks (`notebook_append`); `insertUnder` below is the same placement for the webview's own text.
import { invoke } from "@tauri-apps/api/core";

export interface Appended { created: boolean }

/** An ATX heading line: its level and its text without closing hashes, lower-cased; null for any other line. */
function headingOf(line: string): { level: number; name: string } | null {
  const m = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line.trimEnd());
  return m ? { level: m[1].length, name: (m[2] ?? "").replace(/#+$/, "").trim().toLowerCase() } : null;
}

const isFence = (line: string) => /^\s*(```|~~~)/.test(line);

/** `text` with `line` added under `heading` (a line such as `## Captured`): at the end of that heading's section, after its
 *  last line of text and before the blank lines that precede the next heading. A heading the page lacks is added at its end.
 *  With no heading, `line` goes at the end of the page. A heading inside a fenced code block is not a heading. A page with
 *  Windows line endings keeps them. */
export function insertUnder(text: string, heading: string | null, line: string): string {
  if (heading !== null && !headingOf(heading)) throw new Error("The heading to append under must be a Markdown heading such as ## Captured");
  const crlf = text.includes("\r\n");
  const lf = crlf ? text.replace(/\r\n/g, "\n") : text;
  const done = place(lf, heading, line);
  return crlf ? done.replace(/\n/g, "\r\n") : done;
}

function place(text: string, heading: string | null, line: string): string {
  const wanted = heading === null ? null : headingOf(heading);
  if (!wanted || heading === null) {
    const kept = text.replace(/\n+$/, "");
    return kept ? `${kept}\n${line}\n` : `${line}\n`;
  }
  const lines = text.split("\n");
  // The last piece of a text that ends with a line break is empty and is not a line of the page.
  const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
  let fenced = false;
  let start = -1;
  let end = count;
  for (let i = 0; i < count; i++) {
    if (isFence(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = headingOf(lines[i]);
    if (!h) continue;
    if (start < 0) { if (h.level === wanted.level && h.name === wanted.name) start = i; }
    else if (h.level <= wanted.level) { end = i; break; }
  }
  if (start < 0) {
    const kept = text.replace(/\n+$/, "");
    return kept.trim() ? `${kept}\n\n${heading.trim()}\n\n${line}\n` : `${heading.trim()}\n\n${line}\n`;
  }
  let last = -1;
  for (let i = end - 1; i > start; i--) if (lines[i].trim()) { last = i; break; }
  const out = lines.slice(0, count);
  if (last >= 0) out.splice(last + 1, 0, line);
  else out.splice(start + 1, 0, "", line, ...(start + 1 < count && lines[start + 1].trim() ? [""] : []));
  return `${out.join("\n")}\n`;
}

/** One captured note as a line of a page: the time (and the date, for an inbox), the title and the summary, and the
 *  details as sub-bullets. A summary of several lines continues under the first, indented. */
export function captureLine(when: string, title: string, summary: string, details: string): string {
  const [first = "", ...more] = summary.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const head = title.trim() ? (first ? `${title.trim()}: ${first}` : title.trim()) : first;
  const sub = details.split("\n").map((l) => l.trim().replace(/^[-*+]\s+/, "")).filter(Boolean).map((l) => `  - ${l}`);
  return [`- ${when} ${head}`, ...more.map((l) => `  ${l}`), ...sub].join("\n");
}

/** Add `text` under `heading` of a page of a folder notebook (`container` is its id). Rust changes the page and keeps a
 *  history version. */
export function appendToPage(container: string, path: string, heading: string | null, text: string): Promise<Appended> {
  return invoke<Appended>("notebook_append", { notebook: container, path, heading, text });
}
