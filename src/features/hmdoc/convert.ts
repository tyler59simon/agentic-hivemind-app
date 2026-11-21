// A Markdown page as a rich page (NS-3C). The page is read with NS-3B's `loadPage`; what it holds as source boxes
// (properties, HTML and the rest) stays in source boxes. Attributes that only Markdown needs are dropped: the new page
// is JSON and keeps no slices of the old text.
import type { Node as PMNode } from "@tiptap/pm/model";
import { withTableIds } from "./blocks/table/extensions";
import { FORMAT, SCHEMA_VERSION, stringifyEnvelope } from "./envelope";
import { loadPage } from "../rich/fromMarkdown";
import { richSchema } from "../rich/schema";
import { attrsOf, hmdocSchema } from "./schema";
import { inspect, readContent } from "./validate";

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: Json[]; text?: string };

/** `json` (an NS-3B node) with only the attributes the rich page's type of that name has. */
function adapt(json: Json, schema = hmdocSchema()): Json {
  const out: Json = { type: json.type };
  const kind = json.type === "text" ? null : schema.nodes[json.type];
  if (kind && json.attrs) {
    const attrs = Object.fromEntries(Object.entries(json.attrs).filter(([k]) => k in attrsOf(kind)));
    if (Object.keys(attrs).length) out.attrs = attrs;
  }
  if (json.text !== undefined) out.text = json.text;
  if (json.content) out.content = json.content.map((c) => adapt(c, schema));
  if (json.marks) {
    out.marks = json.marks.map((m) => {
      const attrs = Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([k]) => k in attrsOf(schema.marks[m.type])));
      return Object.keys(attrs).length ? { type: m.type, attrs } : { type: m.type };
    });
  }
  return out;
}

/** The rich page's document for Markdown `source`. */
export function markdownToRichDoc(source: string): PMNode {
  const { doc, original } = loadPage(richSchema(), source);
  let json = adapt(doc.toJSON() as Json);
  if (!readContent(json).ok) {
    // Never a page that opens read-only: a block the rich page cannot hold stays as the source it was written as (R1-12).
    json = { ...json, content: (json.content ?? []).map((block, i) => {
      const at = original.slices[i];
      if (!at || readContent({ type: "doc", content: [block] }).ok) return block;
      return { type: "rawBlock", attrs: { kind: "block", value: source.slice(at.from, at.to) } };
    }) };
  }
  const read = readContent(json);
  if (!read.ok) throw new Error(`This page cannot be converted: ${read.reason}`);
  return withTableIds(read.doc);
}

/** The text of the `.hmdoc` file that Markdown `source` converts to. `title` is the page's name. */
export function convertMarkdown(source: string, title: string): string {
  const text = stringifyEnvelope({
    schemaVersion: SCHEMA_VERSION, format: FORMAT, meta: { title },
    content: markdownToRichDoc(source).toJSON(),
  });
  // What is written is what the editor will open: a file that would not is never made.
  const read = inspect(text);
  if (!read.ok) throw new Error(`This page cannot be converted: ${read.reason}`);
  return text;
}
