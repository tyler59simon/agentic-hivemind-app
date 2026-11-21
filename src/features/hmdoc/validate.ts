// Is this file's document one the editor can hold without dropping anything? (NS-3C) ProseMirror's `Node.fromJSON`
// silently drops attributes its schema does not have, so every node's and mark's keys are compared with its type first;
// then `fromJSON` and `check()` test the structure. A file that fails opens read-only, with the reason.
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Node } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { parseEnvelope, type Envelope, type Opened } from "./envelope";
import { holdsFreeform } from "./blocks/freeform";
import { attrAccepts, nodeProblem } from "./rules";
import { attrsOf, hmdocSchema } from "./schema";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const NODE_KEYS = new Set(["type", "attrs", "content", "marks", "text"]);

/** What is wrong with one node or mark's attributes, or null. */
function attrProblem(kind: "node" | "mark", name: string, attrs: unknown, known: Record<string, unknown>): string | null {
  if (attrs === undefined) return null;
  if (!isObject(attrs)) return `a ${kind} "${name}" whose attributes are not an object`;
  for (const [key, value] of Object.entries(attrs)) {
    if (!(key in known)) return `an unknown attribute "${key}" on the ${kind} "${name}"`;
    if (!attrAccepts(name, key, value)) return `a value Hivemind does not accept for "${key}" on the ${kind} "${name}"`;
  }
  return null;
}

function problemIn(schema: Schema, json: unknown, depth = 0): string | null {
  if (!isObject(json)) return "a node that is not an object";
  if (depth > 200) return "nodes nested too deeply";
  for (const key of Object.keys(json)) if (!NODE_KEYS.has(key)) return `an unknown field "${key}" in a node`;
  const name = json.type;
  if (typeof name !== "string") return "a node with no type";
  // ProseMirror drops what does not belong to the kind of node without a word.
  if (name === "text" && json.content !== undefined) return "a text node with content";
  if (name !== "text" && json.text !== undefined) return `a node "${name}" with text of its own`;
  const type = schema.nodes[name];
  if (!type) return `an unknown node "${name}"`;
  const bad = attrProblem("node", name, json.attrs, attrsOf(type));
  if (bad) return bad;
  if (json.marks !== undefined) {
    if (!Array.isArray(json.marks)) return `a node "${name}" whose marks are not a list`;
    for (const mark of json.marks) {
      if (!isObject(mark)) return "a mark that is not an object";
      for (const key of Object.keys(mark)) if (key !== "type" && key !== "attrs") return `an unknown field "${key}" in a mark`;
      const markName = mark.type;
      const markType = typeof markName === "string" ? schema.marks[markName] : undefined;
      if (!markType) return `an unknown mark "${String(markName)}"`;
      const markBad = attrProblem("mark", markName as string, mark.attrs, attrsOf(markType));
      if (markBad) return markBad;
    }
  }
  if (json.content !== undefined) {
    if (!Array.isArray(json.content)) return `a node "${name}" whose content is not a list`;
    for (const child of json.content) {
      const found = problemIn(schema, child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** The document in `content`, or what is wrong with it. */
export function readContent(content: unknown, schema: Schema = hmdocSchema()): { ok: true; doc: PMNode } | { ok: false; reason: string } {
  const problem = problemIn(schema, content);
  if (problem) return { ok: false, reason: `This file is read-only: it has ${problem}. It may be from a newer Hivemind.` };
  try {
    const doc = Node.fromJSON(schema, content);
    doc.check();
    let malformed = false;
    let embedProblem: string | null = null;
    doc.descendants((node) => {
      // Cells of a column that disagree about its width are mended on the first edit; nothing else is.
      if (node.type.name === "table" && TableMap.get(node).problems?.some((p) => p.type !== "colwidth mismatch")) malformed = true;
      // An embed or frame whose attributes are not values Hivemind accepts (a missing path is the default, which is none),
      // and a free-positioned block inside a frame (NS-3D).
      embedProblem ??= nodeProblem(node.type.name, node.attrs);
      if (node.type.name === "frame" && holdsFreeform(node)) embedProblem ??= "a free-positioned block inside a frame";
      return !malformed && !embedProblem;
    });
    if (malformed) return { ok: false, reason: "This file is read-only: it has a table whose cells do not fit a grid." };
    if (embedProblem) return { ok: false, reason: `This file is read-only: it has ${embedProblem}.` };
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, reason: `This file is read-only: its document is not valid (${e instanceof Error ? e.message : String(e)}).` };
  }
}

export type Inspected = { ok: true; envelope: Envelope; doc: PMNode } | Extract<Opened, { ok: false }>;

/** A `.hmdoc` file's text as an envelope and a document, or the reason it opens read-only. */
export function inspect(text: string): Inspected {
  const opened = parseEnvelope(text);
  if (!opened.ok) return opened;
  const read = readContent(opened.envelope.content);
  return read.ok ? { ok: true, envelope: opened.envelope, doc: read.doc } : read;
}
