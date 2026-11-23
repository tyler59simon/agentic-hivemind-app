// Living Memory notebook pages (NS-2C), read and written through the `doc` commands. Such a page is named by the
// container id `lm:<domain>:<notebook>` and its path in the notebook, as a loose file is named `@<grant>` and its file
// name, so the document store, tabs and drafts treat it like any page. A page is UTF-8 by Living Memory's rule; this
// file applies the same byte-order-mark and line-ending rules as the Rust file service (`files/mod.rs` decode and
// encode), so the editor gets LF text and a save writes the bytes back as they were except where the text changed.
import { invoke } from "@tauri-apps/api/core";
import { bridgeGeneration, docCreate, docDelete, docList, docRead, docReadFile, docWrite, LmError, type DocPage } from "../../lib/lm";
import type { Eol, FileFormat, Loaded, SaveOutcome, Stamp, Tree } from "../../lib/notebooks";

export const LM = "lm:";
export interface LmNotebookRef { domain: string; notebook: string }

/** The container id of a Living Memory notebook. */
export const lmContainer = (domain: string, notebook: string) => `${LM}${domain}:${notebook}`;

/** Living Memory's names (`common.safe_domain`, `docs.SLUG`), checked the same way by Rust's `lmdoc::parse`, so a
 *  notebook either works everywhere or nowhere (Codex review of 32fee20, C3). A domain is also a folder name. */
const DOMAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;
const NOTEBOOK = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function parseLm(container: string): LmNotebookRef | null {
  if (!container.startsWith(LM)) return null;
  const rest = container.slice(LM.length);
  const at = rest.indexOf(":");
  const domain = rest.slice(0, at), notebook = rest.slice(at + 1);
  return at > 0 && DOMAIN.test(domain) && NOTEBOOK.test(notebook) ? { domain, notebook } : null;
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
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Living Memory's "not found" (a page, or a notebook that is gone), said the way the document store recognises a
 *  missing file (`isMissing`). */
export const notFound = (e: unknown) => e instanceof LmError && /^not_found:/.test(e.message);
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
  return loadedPage(page);
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

/** Create a page; with `format`, editor text is written with that format's line endings and byte order mark (a gone
 *  page created again keeps the format it had, Codex review of 32fee20, D5). */
export async function createPage(where: LmNotebookRef, path: string, text: string, format?: FileFormat): Promise<Stamp> {
  const body = format ? pageBody(text, format) : text;
  const receipt = await docCreate(where.domain, where.notebook, path, body);
  return { sha256: receipt.revision ?? (await sha256(body)), size: encoder.encode(body).length, mtimeMs: Date.now() };
}

/** Delete a page. Without `pre` (the page is not open) it is deleted as it is now. */
export async function deletePage(where: LmNotebookRef, path: string, pre?: Stamp, at?: number): Promise<string> {
  const revision = pre?.sha256 ?? (await docRead(where.domain, where.notebook, path, at).catch((e) => { throw missing(e); })).revision;
  await docDelete(where.domain, where.notebook, path, revision, at);
  return path;
}

/** Move a page or section. Rust moves the drafts of the pages with it, as `file_rename` does (NS-2C). */
export const movePage = (container: string, from: string, to: string, at = bridgeGeneration()) => invoke<void>("lmdoc_move", { notebook: container, from, to, generation: at });

/** Ask for a file with the native dialog and copy it into the notebook's `assets/`; null when the user cancelled. */
export const attachFile = (container: string) => invoke<string | null>("lmdoc_attach", { notebook: container, generation: bridgeGeneration() });

/** Open an attachment (`assets/...`) with the program Windows uses for its kind. Rust opens a read-only copy, so the
 *  store keeps Living Memory as its only writer (Codex review of 32fee20, U2). */
export const openAttachment = (container: string, path: string) => invoke<void>("lmdoc_open_asset", { notebook: container, path });

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
