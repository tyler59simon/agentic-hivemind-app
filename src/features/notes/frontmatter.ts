// Reading and editing the frontmatter of a page (NS-7B). The `yaml` package parses it; an edit then changes only the bytes
// of the value (or the lines of the key) it is about and copies every other byte of the page as it was, so comments, key
// order, quoting, spacing and line endings of the keys the user did not touch stay exactly as written. The document API
// would write the whole block again in its own style, which is why it is used only to find where things are and to quote
// a new value.
import { Document, isMap, isScalar, isSeq, parseDocument, type Pair, type Scalar, type YAMLMap } from "yaml";

export type PropValue = string | number | boolean | string[];
export type PropKind = "text" | "number" | "date" | "checkbox" | "list" | "link";

/** One property as the panel shows it. `editable` is false for a value the panel does not write (a nested map, a list of
 *  maps): `source` is then what the page has, to show as it is. */
export interface PropRow { key: string; kind: PropKind; value: PropValue; editable: boolean; source: string }

export type PropsRead = { state: "none" } | { state: "bad"; reason: string } | { state: "ok"; props: PropRow[] };

interface Block {
  /** Where the YAML starts (after the opening `---` line) and where the closing line starts. */
  from: number;
  close: number;
  /** The line ending the block's own lines use. */
  eol: string;
}

/** The frontmatter block at the start of `text` (after a byte order mark, if any): between a `---` line and the next `---`
 *  or `...` line, as the index reads it. */
export function frontBlock(text: string): Block | null {
  const start = text.startsWith("﻿") ? 1 : 0;
  const open = /^---[ \t]*(\r?\n)/.exec(text.slice(start));
  if (!open) return null;
  const from = start + open[0].length;
  let at = from;
  while (at <= text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end).replace(/\r$/, "").trimEnd();
    if (line === "---" || line === "...") return { from, close: at, eol: open[1] };
    if (end >= text.length) return null;
    at = end + 1;
  }
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK = /^\[\[[^\]]+\]\]$/;

/** The kind of field a value gets. */
export function kindOf(value: PropValue): PropKind {
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (DATE.test(value)) return "date";
  return LINK.test(value) ? "link" : "text";
}

/** The typed value the text of a property stands for: a number, `true` or `false`, else the text. The index and Living
 *  Memory hold every value as text, so a value written back from a table cell or a board column is read this way, to keep a
 *  number a number. */
export function fromText(text: string): PropValue {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && Number.isFinite(Number(t)) && String(Number(t)) === t) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return text;
}

function parse(text: string): { block: Block; body: string; doc: Document.Parsed } | { error: string } {
  const block = frontBlock(text);
  if (!block) return { error: "none" };
  const body = text.slice(block.from, block.close);
  const doc = parseDocument(body);
  if (doc.errors.length) return { error: `The properties are not valid YAML (${doc.errors[0].message.split("\n")[0]})` };
  if (doc.contents !== null && !isMap(doc.contents)) return { error: "The properties are not a list of keys and values" };
  if (isMap(doc.contents) && doc.contents.flow) return { error: "The properties are written as one line in braces" };
  return { block, body, doc };
}

/** The source range of a node of the parsed document: where its value starts and ends. */
const rangeOf = (node: unknown): [number, number] | null => {
  const range = (node as { range?: [number, number, number] | null } | null)?.range;
  return range ? [range[0], range[1]] : null;
};

const keyOf = (pair: Pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key));

function rowOf(pair: Pair, body: string): PropRow {
  const key = keyOf(pair);
  const node = pair.value;
  const source = isScalar(node) || isSeq(node) || isMap(node) ? body.slice(node.range![0], node.range![1]).trim() : "";
  if (node === null || (isScalar(node) && node.value === null)) return { key, kind: "text", value: "", editable: true, source };
  if (isScalar(node)) {
    const v = node.value;
    const value: PropValue = typeof v === "boolean" || typeof v === "number" ? v : String(v);
    return { key, kind: kindOf(value), value, editable: true, source };
  }
  if (isSeq(node) && node.items.every((i) => isScalar(i))) {
    return { key, kind: "list", value: node.items.map((i) => String((i as Scalar).value ?? "")), editable: true, source };
  }
  return { key, kind: "text", value: source, editable: false, source };
}

/** The properties a page has. */
export function readProps(text: string): PropsRead {
  const found = parse(text);
  if ("error" in found) return found.error === "none" ? { state: "none" } : { state: "bad", reason: found.error };
  const map = found.doc.contents as YAMLMap | null;
  return { state: "ok", props: (map?.items ?? []).map((pair) => rowOf(pair as Pair, found.body)) };
}

/** `value` as YAML. A string keeps the quotes the old value had (`old`); the rest is quoted only where YAML needs it. */
function scalarText(value: string | number | boolean, old?: Scalar | null): string {
  if (typeof value === "string") {
    const one = value.replace(/\r?\n/g, " ");
    if (old?.type === "QUOTE_DOUBLE") return JSON.stringify(one);
    if (old?.type === "QUOTE_SINGLE") return `'${one.replace(/'/g, "''")}'`;
    return new Document(one).toString({ lineWidth: 0 }).trimEnd();
  }
  return new Document(value).toString({ lineWidth: 0 }).trimEnd();
}

const flowList = (items: string[]) => new Document(items.map((i) => i.replace(/\r?\n/g, " "))).toString({ collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trimEnd();

/** Where a block collection's text ends: before the line ending that follows its last line. */
function trimEol(body: string, end: number) {
  let at = end;
  if (body[at - 1] === "\n") at--;
  if (body[at - 1] === "\r") at--;
  return at;
}

/** The text of `value` for the place of `old` in the block: the replacement, and the range of the body it replaces. */
function replacement(body: string, pair: Pair, value: PropValue, eol: string): { from: number; to: number; text: string } {
  const node = pair.value;
  const key = pair.key as Scalar;
  if (isSeq(node) && !node.flow) {
    const [from] = node.range!;
    const to = trimEol(body, node.range![1]);
    if (Array.isArray(value) && value.length) {
      const indent = " ".repeat(from - (body.lastIndexOf("\n", from - 1) + 1));
      return { from, to, text: value.map((v) => `- ${scalarText(v)}`).join(eol + indent) };
    }
    // Another kind of value takes the place of the whole block, on the key's line.
    const colon = body.indexOf(":", key.range![1]);
    return { from: colon + 1, to, text: ` ${Array.isArray(value) ? "[]" : scalarText(value)}` };
  }
  if (isMap(node)) {
    const colon = body.indexOf(":", key.range![1]);
    return { from: colon + 1, to: trimEol(body, node.range![1]), text: ` ${Array.isArray(value) ? flowList(value) : scalarText(value)}` };
  }
  const old = isScalar(node) ? node : null;
  const text = Array.isArray(value) ? flowList(value) : scalarText(value, old);
  const range = rangeOf(node);
  if (!range) {
    const at = body.indexOf(":", key.range![1]) + 1;
    return { from: at, to: at, text: ` ${text}` };
  }
  const [from, to] = range;
  if (from !== to) return { from, to, text };
  // `key:` with no value has an empty range: right after the colon, which needs its space, or before a comment, which needs
  // one after the value.
  return { from, to, text: `${body[from - 1] === ":" ? " " : ""}${text}${body[from] === "#" ? " " : ""}` };
}

/** `text` with the property `key` set to `value`: the value of that key replaced where it stands, or a new line added at the
 *  end of the frontmatter (a page with none gets a block at its top). Throws when the properties cannot be edited. */
export function setProp(text: string, key: string, value: PropValue): string {
  const found = parse(text);
  if ("error" in found) {
    if (found.error !== "none") throw new Error(found.error);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const bom = text.startsWith("﻿") ? "﻿" : "";
    return `${bom}---${eol}${newLine(key, value)}${eol}---${eol}${text.slice(bom.length)}`;
  }
  const { block, body, doc } = found;
  const pair = (doc.contents as YAMLMap | null)?.items.find((p) => keyOf(p as Pair) === key) as Pair | undefined;
  if (!pair) {
    const at = block.close;
    // The block's last line has its line ending before the closing line, except when the block is empty.
    return `${text.slice(0, at)}${newLine(key, value)}${block.eol}${text.slice(at)}`;
  }
  const { from, to, text: changed } = replacement(body, pair, value, block.eol);
  const base = block.from;
  return text.slice(0, base + from) + changed + text.slice(base + to);
}

const newLine = (key: string, value: PropValue) => `${scalarText(key)}: ${Array.isArray(value) ? flowList(value) : scalarText(value)}`;

/** `text` without the property `key`: the lines of that key (a block list or map included) are removed, and nothing else.
 *  A key the page does not have changes nothing. */
export function removeProp(text: string, key: string): string {
  const found = parse(text);
  if ("error" in found) {
    if (found.error !== "none") throw new Error(found.error);
    return text;
  }
  const { block, body, doc } = found;
  const pair = (doc.contents as YAMLMap | null)?.items.find((p) => keyOf(p as Pair) === key) as Pair | undefined;
  if (!pair) return text;
  const keyRange = (pair.key as Scalar).range!;
  const valueEnd = Math.max(rangeOf(pair.value)?.[1] ?? 0, keyRange[1]);
  const start = body.lastIndexOf("\n", keyRange[0] - 1) + 1;
  // A value that ends at a line's start (a block list) already includes its last line ending.
  const end = body[valueEnd - 1] === "\n" ? valueEnd : (() => { const nl = body.indexOf("\n", valueEnd); return nl < 0 ? body.length : nl + 1; })();
  return text.slice(0, block.from + start) + text.slice(block.from + end);
}
