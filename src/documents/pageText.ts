// A page as Living Memory returns it (`doc read --file`, a folder notebook's page Hivemind has no notebook for) and as a
// folder proposal carries it. A page is UTF-8 by Living Memory's rule; this file applies the same byte-order-mark and
// line-ending rules as the Rust file service (`files/mod.rs` decode and encode), so the editor gets LF text and a write
// puts the bytes back as they were except where the text changed.
import { docReadFile, LmError, type DocPage } from "../lib/lm";
import type { Eol, FileFormat, Loaded } from "../lib/notebooks";

/** The line-ending style of `text`, by the rules of `files::detect_eol`. */
export function detectEol(text: string): Eol {
  let lf = 0, crlf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
    } else if (c === 10) lf++;
  }
  if (!lf && !crlf && !cr) return "none";
  if (!crlf && !cr) return "lf";
  if (!lf && !cr) return "crlf";
  if (!lf && !crlf) return "cr";
  return "mixed";
}

/** A page's text as Living Memory returned it, split into the editor's LF text and the format a save writes back. A
 *  page that mixes line endings opens read-only, as such a file does. */
export function pageText(raw: string): { text: string; format: FileFormat; readOnly: string | null } {
  const bom = raw.startsWith("﻿");
  const body = bom ? raw.slice(1) : raw;
  const eol = detectEol(body);
  const format: FileFormat = { encoding: "UTF-8", bom, eol, confidence: "valid" };
  const text = eol === "lf" || eol === "none" ? body : body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text, format, readOnly: eol === "mixed" ? "This page mixes line-ending styles" : null };
}

/** The page text to send for editor text in `format`: line endings and byte order mark as the page had them. */
export function pageBody(text: string, format: FileFormat): string {
  if (format.eol === "mixed") throw new Error("This page mixes line-ending styles, so Hivemind does not save it");
  let out = text.replace(/\r\n/g, "\n");
  if (format.eol === "crlf") out = out.replace(/\n/g, "\r\n");
  else if (format.eol === "cr") out = out.replace(/\n/g, "\r");
  return (format.bom ? "﻿" : "") + out;
}

const encoder = new TextEncoder();
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Living Memory's "not found", said the way the document store recognises a missing file (`isMissing`). */
const notFound = (e: unknown) => e instanceof LmError && /^not_found:/.test(e.message);
function missing(e: unknown): unknown {
  return notFound(e) ? new Error(`${(e as Error).message.replace(/^not_found:\s*/, "")}: it does not exist (it was deleted or moved)`) : e;
}

/** A page of a folder notebook Hivemind has no notebook for, read through Living Memory by its file path (`doc read --file`). */
export async function readFolderPage(file: string): Promise<Loaded> {
  let page;
  try {
    page = await docReadFile(file);
  } catch (e) {
    throw missing(e);
  }
  return loadedPage(page);
}

async function loadedPage(page: DocPage): Promise<Loaded> {
  // `doc read` decodes with replacement characters, so text whose bytes were not UTF-8 would be saved changed. The
  // revision is the SHA-256 of the page's bytes: text that encodes back to it is the page exactly.
  const exact = !page.truncated && (await sha256(page.text)) === page.revision;
  const { text, format, readOnly } = pageText(page.text);
  return {
    text, sha256: page.revision, size: page.size, mtimeMs: Date.parse(page.updated) || 0, format, binary: false, convertible: false,
    readOnly: exact ? readOnly : "This page holds bytes that are not UTF-8, which Hivemind cannot save unchanged",
  };
}
