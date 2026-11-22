// Adding a line to a notebook page (NS-7A): Quick capture's "Today's page" and "Inbox" targets. The placement is the same as
// Rust's `append::insert_under`, which does it for folder notebooks (`notebook_append`); a Living Memory page is read,
// changed and written here, against the revision it was read at.
import { invoke } from "@tauri-apps/api/core";
import { notFound, pageBody, pageText, parseLm, sha256, type LmNotebookRef } from "../../documents/adapters/lmdoc";
import { docCreate, docRead, docWrite, LmError } from "../../lib/lm";

/** How many times an append reads the page again after another change got in between its read and its write. */
export const ATTEMPTS = 3;

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

/** Add `text` to a Living Memory page (made when it is missing): read, changed and written against the revision read, with
 *  up to `ATTEMPTS` rounds when another change got in between. A page Living Memory gave only the start of is refused, and
 *  so is one that is not text Hivemind can save back unchanged, since a write sends the whole page. `between` runs after each
 *  read and before its write (tests change the page there). */
export async function appendToLmPage(where: LmNotebookRef, path: string, heading: string | null, text: string, between: (attempt: number) => Promise<void> | void = () => {}): Promise<Appended> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let page;
    try {
      page = await docRead(where.domain, where.notebook, path);
    } catch (e) {
      if (!notFound(e)) throw e;
      try {
        await docCreate(where.domain, where.notebook, path, insertUnder("", heading, text));
        return { created: true };
      } catch (again) {
        // Made by someone else since the read: read it on the next round.
        if (/exists/i.test(String(again instanceof Error ? again.message : again))) continue;
        throw again;
      }
    }
    if (page.truncated) throw new Error(`${path} is too long for Hivemind to add to: Living Memory gave only the start of it, and writing it back would drop the rest. Nothing was added`);
    const { text: lf, format, readOnly } = pageText(page.text);
    if (readOnly || (await sha256(page.text)) !== page.revision) throw new Error(`${path} cannot be edited here: ${readOnly ?? "it holds bytes that are not UTF-8"}. Nothing was added`);
    const body = pageBody(insertUnder(lf, heading, text), format);
    await between(attempt);
    try {
      await docWrite(where.domain, where.notebook, path, body, page.revision);
      return { created: false };
    } catch (e) {
      if (!(e instanceof LmError && e.stale)) throw e;
    }
  }
  throw new Error(`${path} kept changing while the line was added, so it was not saved. Try again`);
}

/** Add `text` under `heading` of a page of either kind of notebook (`container` is a folder notebook's id or a Living Memory
 *  notebook's `lm:<domain>:<notebook>`). A folder notebook's page is changed by Rust, which also keeps a history version. */
export function appendToPage(container: string, path: string, heading: string | null, text: string): Promise<Appended> {
  const lm = parseLm(container);
  return lm ? appendToLmPage(lm, path, heading, text) : invoke<Appended>("notebook_append", { notebook: container, path, heading, text });
}
