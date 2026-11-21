// The `.hmdoc` file (NS-3C): a JSON envelope around a ProseMirror document. This file knows the envelope only, so the
// file tab can check it without loading the editor. The document inside is checked by `validate.ts`.
import type { Node as PMNode } from "@tiptap/pm/model";
import { PAGE_WIDTHS, type PageWidth } from "./palette";

export const FORMAT = "hivemind-rich";
export const SCHEMA_VERSION = 1;
/** A file longer than this (in characters) opens as read-only JSON. */
export const SIZE_LIMIT = 5_000_000;

export const FILTER_OPS = ["contains", "equals", "greater", "less", "empty", "filled"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** A table's sort and filter, kept with the page and never applied to the stored rows. */
export interface TableView {
  sort?: { column: number; dir: "asc" | "desc" };
  filter?: { column: number; op: FilterOp; value: string };
}

export interface Meta {
  title?: string;
  /** A picture of the notebook, by its path from the notebook's root. */
  cover?: string;
  width?: PageWidth;
  /** By table id. */
  views?: Record<string, TableView>;
}

export interface Envelope {
  schemaVersion: typeof SCHEMA_VERSION;
  format: typeof FORMAT;
  meta: Meta;
  content: Record<string, unknown>;
}

export type Opened = { ok: true; envelope: Envelope } | { ok: false; reason: string; newer?: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Why `meta` is not a page's metadata, or null. Unknown keys are refused: saving would drop them. */
function metaProblem(meta: unknown): string | null {
  if (!isObject(meta)) return "its metadata is not an object";
  for (const [key, value] of Object.entries(meta)) {
    if (key === "title" || key === "cover") {
      if (typeof value !== "string") return `its ${key} is not text`;
    } else if (key === "width") {
      if (!(PAGE_WIDTHS as readonly unknown[]).includes(value)) return "its page width is not normal, wide or full";
    } else if (key === "views") {
      if (!isObject(value)) return "its table views are not an object";
      for (const view of Object.values(value)) {
        if (!isObject(view)) return "a table view is not an object";
        for (const [k, v] of Object.entries(view)) {
          if (k === "sort") {
            if (!isObject(v) || !isIndex(v.column) || (v.dir !== "asc" && v.dir !== "desc") || Object.keys(v).length !== 2) return "a table sort is malformed";
          } else if (k === "filter") {
            if (!isObject(v) || !isIndex(v.column) || !(FILTER_OPS as readonly unknown[]).includes(v.op) || typeof v.value !== "string" || Object.keys(v).length !== 3) return "a table filter is malformed";
          } else return `a table view has an unknown field "${k}"`;
        }
      }
    } else return `its metadata has an unknown field "${key}"`;
  }
  return null;
}

/** Why a file is too large to edit, or null. Checked before anything parses it. */
export const oversizeReason = (text: string): string | null =>
  text.length > SIZE_LIMIT ? `This file is over ${SIZE_LIMIT.toLocaleString("en-US")} characters, so it opens as read-only JSON.` : null;

/** Read a `.hmdoc` file's text. A file that is not ours to edit says why, in words for a banner. */
export function parseEnvelope(text: string): Opened {
  const big = oversizeReason(text);
  if (big) return { ok: false, reason: big };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `This file is not valid JSON (${e instanceof Error ? e.message : String(e)}), so it opens as read-only JSON.` };
  }
  if (!isObject(raw)) return { ok: false, reason: "This file is not a Hivemind rich page, so it opens as read-only JSON." };
  if (raw.format !== FORMAT) return { ok: false, reason: `This file has another format (${JSON.stringify(raw.format) ?? "none"}), so it opens as read-only JSON.` };
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, reason: "This file has an unknown schema version, so it opens as read-only JSON." };
  if (version > SCHEMA_VERSION) return { ok: false, newer: true, reason: `Made by a newer Hivemind (schema version ${version}), so it opens as read-only JSON.` };
  for (const key of Object.keys(raw)) {
    if (!["schemaVersion", "format", "meta", "content"].includes(key)) return { ok: false, reason: `This file has an unknown field "${key}", so it opens as read-only JSON.` };
  }
  const meta = raw.meta ?? {};
  const problem = metaProblem(meta);
  if (problem) return { ok: false, reason: `This file is read-only: ${problem}.` };
  if (!isObject(raw.content) || raw.content.type !== "doc") return { ok: false, reason: "This file has no document, so it opens as read-only JSON." };
  return { ok: true, envelope: { schemaVersion: SCHEMA_VERSION, format: FORMAT, meta: meta as Meta, content: raw.content } };
}

/** `value` as JSON with every object's keys sorted and two-space indentation: the same document is always the same text,
 *  so a diff shows only what changed. `pad` is the indentation of the line the value starts on. */
export function stable(value: unknown, pad = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const inner = `${pad}  `;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => `${inner}${stable(v, inner)}`).join(",\n")}\n${pad}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  if (!keys.length) return "{}";
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${stable(obj[k], inner)}`).join(",\n")}\n${pad}}`;
}

/** The file's text: sorted keys, two-space indentation, LF and a final line break. */
export const stringifyEnvelope = (envelope: Envelope): string => `${stable(envelope)}\n`;

/** What each top-level block was written as, by node: typing in a long page rewrites one block, not all of them. */
const blockTexts = new WeakMap<PMNode, string>();

/** The file's text for an editor document, the same text `stringifyEnvelope` gives for the document's JSON. */
export function stringifyDocument(doc: PMNode, meta: Meta): string {
  const blocks: string[] = [];
  doc.forEach((b) => {
    let text = blockTexts.get(b);
    if (text === undefined) { text = stable(b.toJSON(), "      "); blockTexts.set(b, text); }
    blocks.push(text);
  });
  if (!blocks.length) return stringifyEnvelope({ schemaVersion: SCHEMA_VERSION, format: FORMAT, meta, content: doc.toJSON() });
  return `{\n  "content": {\n    "content": [\n${blocks.map((b) => `      ${b}`).join(",\n")}\n    ],\n    "type": "doc"\n  },\n  "format": ${JSON.stringify(FORMAT)},\n  "meta": ${stable(meta, "  ")},\n  "schemaVersion": ${SCHEMA_VERSION}\n}\n`;
}

/** The text of a new rich page: one empty paragraph. */
export function newPageText(title: string): string {
  return stringifyEnvelope({
    schemaVersion: SCHEMA_VERSION, format: FORMAT, meta: { title },
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
}
