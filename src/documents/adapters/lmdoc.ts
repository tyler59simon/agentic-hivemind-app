// Living Memory notebook pages (NS-2C), read and written through the `doc` commands. Such a page is named by the
// container id `lm:<domain>:<notebook>` and its path in the notebook, as a loose file is named `@<grant>` and its file
// name, so the document store, tabs and drafts treat it like any page. A page is UTF-8 by Living Memory's rule; this
// file applies the same byte-order-mark and line-ending rules as the Rust file service (`files/mod.rs` decode and
// encode), so the editor gets LF text and a save writes the bytes back as they were except where the text changed.
import { invoke } from "@tauri-apps/api/core";
import { docCreate, docDelete, docList, docRead, docWrite, LmError } from "../../lib/lm";
import type { Eol, FileFormat, Loaded, SaveOutcome, Stamp, Tree } from "../../lib/notebooks";

export const LM = "lm:";
export interface LmNotebookRef { domain: string; notebook: string }

/** The container id of a Living Memory notebook. Domain names are folder names (never a colon); notebook ids are
 *  lowercase letters, digits and hyphens. */
export const lmContainer = (domain: string, notebook: string) => `${LM}${domain}:${notebook}`;

export function parseLm(container: string): LmNotebookRef | null {
  if (!container.startsWith(LM)) return null;
  const rest = container.slice(LM.length);
  const at = rest.indexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { domain: rest.slice(0, at), notebook: rest.slice(at + 1) };
}

export const isLm = (ref: { notebook: string }) => ref.notebook.startsWith(LM);

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
async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Living Memory's "not found" (a page, or a notebook that is gone), said the way the document store recognises a
 *  missing file (`isMissing`). */
const notFound = (e: unknown) => e instanceof LmError && /^not_found:/.test(e.message);
function missing(e: unknown): unknown {
  return notFound(e) ? new Error(`${(e as Error).message.replace(/^not_found:\s*/, "")}: it does not exist (it was deleted or moved)`) : e;
}

export async function readPage(where: LmNotebookRef, path: string): Promise<Loaded> {
  let page;
  try {
    page = await docRead(where.domain, where.notebook, path);
  } catch (e) {
    throw missing(e);
  }
  // `doc read` decodes with replacement characters, so text whose bytes were not UTF-8 would be saved changed. The
  // revision is the SHA-256 of the page's bytes: text that encodes back to it is the page exactly.
  const exact = !page.truncated && (await sha256(page.text)) === page.revision;
  const { text, format, readOnly } = pageText(page.text);
  return {
    text, sha256: page.revision, size: page.size, mtimeMs: Date.parse(page.updated) || 0, format, binary: false, convertible: false,
    readOnly: exact ? readOnly : "This page holds bytes that are not UTF-8, which Hivemind cannot save unchanged",
  };
}

/** Write a page against the revision it was read at. A page changed meanwhile is `stale`; one that is gone, `gone`. */
export async function savePage(where: LmNotebookRef, path: string, text: string, pre: Stamp, format: FileFormat): Promise<SaveOutcome> {
  const body = pageBody(text, format);
  try {
    const receipt = await docWrite(where.domain, where.notebook, path, body, pre.sha256);
    return { status: "saved", sha256: receipt.revision ?? (await sha256(body)), size: encoder.encode(body).length, mtimeMs: Date.now() };
  } catch (e) {
    if (e instanceof LmError && e.stale) return { status: "stale", sha256: "" };
    if (notFound(e)) return { status: "gone" };
    throw e;
  }
}

export async function createPage(where: LmNotebookRef, path: string, text: string): Promise<Stamp> {
  const receipt = await docCreate(where.domain, where.notebook, path, text);
  return { sha256: receipt.revision ?? (await sha256(text)), size: encoder.encode(text).length, mtimeMs: Date.now() };
}

/** Delete a page. Without `pre` (the page is not open) it is deleted as it is now. */
export async function deletePage(where: LmNotebookRef, path: string, pre?: Stamp): Promise<string> {
  const revision = pre?.sha256 ?? (await docRead(where.domain, where.notebook, path).catch((e) => { throw missing(e); })).revision;
  await docDelete(where.domain, where.notebook, path, revision);
  return path;
}

/** Move a page or section. Rust moves the drafts of the pages with it, as `file_rename` does (NS-2C). */
export const movePage = (container: string, from: string, to: string) => invoke<void>("lmdoc_move", { notebook: container, from, to });

/** Ask for a file with the native dialog and copy it into the notebook's `assets/`; null when the user cancelled. */
export const attachFile = (container: string) => invoke<string | null>("lmdoc_attach", { notebook: container });

/** The notebook's sections and pages in the shape of a folder notebook's tree. */
export async function pageTree(where: LmNotebookRef): Promise<Tree> {
  const listed = await docList(where.domain, where.notebook);
  return {
    entries: listed.entries.map((e) => ({
      path: e.path, kind: e.kind === "folder" ? "dir" : "page", size: e.size ?? 0, mtimeMs: e.updated ? Date.parse(e.updated) || 0 : 0,
    })),
    truncated: false,
  };
}

/** The relative link from the page at `page` to an attachment at `asset` (both paths in the notebook). */
export function assetLink(page: string, asset: string): string {
  const depth = page.split("/").length - 1;
  return `${"../".repeat(depth)}${asset.split("/").map(encodeURIComponent).join("/")}`;
}
