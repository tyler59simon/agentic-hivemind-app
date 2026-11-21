// NS-3C: the `.hmdoc` envelope and its document. A file the editor cannot hold without dropping something opens read-only
// with the reason; a good file reads back to the same bytes.
import { describe, expect, it } from "vitest";
import { newPageText, oversizeReason, parseEnvelope, SIZE_LIMIT, stable, stringifyDocument, stringifyEnvelope, type Envelope } from "./envelope";
import { hmdocSchema } from "./schema";
import { inspect, readContent } from "./validate";

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const file = (content: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, format: "hivemind-rich", meta: {}, content, ...over });
const reason = (text: string) => { const r = inspect(text); return r.ok ? null : r.reason; };

describe("opening a file", () => {
  it("accepts a good file", () => {
    const r = inspect(file(doc(para("Hello"))));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.textContent).toBe("Hello");
  });

  it("a schema version other than 1 opens read-only; a newer one says so", () => {
    const newer = inspect(file(doc(para("x")), { schemaVersion: 2 }));
    expect(newer).toMatchObject({ ok: false, newer: true });
    expect(!newer.ok && newer.reason).toContain("Made by a newer Hivemind");
    expect(reason(file(doc(para("x")), { schemaVersion: 0 }))).toContain("unknown schema version");
    expect(reason(file(doc(para("x")), { schemaVersion: "1" }))).toContain("unknown schema version");
  });

  it("another format, text that is not JSON, and a file that is not an object open read-only", () => {
    expect(reason(file(doc(), { format: "something-else" }))).toContain("another format");
    expect(reason("{ not json")).toContain("not valid JSON");
    expect(reason("")).toContain("not valid JSON");
    expect(reason("[1, 2]")).toContain("not a Hivemind rich page");
    expect(reason(file(null))).toContain("no document");
  });

  it("an unknown node, mark or attribute opens read-only, since it would be dropped on saving", () => {
    expect(reason(file(doc({ type: "sparkline" })))).toContain('unknown node "sparkline"');
    expect(reason(file(doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "glow" }] }] })))).toContain('unknown mark "glow"');
    // fromJSON would drop this attribute without a word.
    expect(reason(file(doc({ type: "heading", attrs: { level: 1, shout: true }, content: [{ type: "text", text: "x" }] })))).toContain('unknown attribute "shout" on the node "heading"');
    expect(reason(file(doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold", attrs: { x: 1 } }] }] })))).toContain('unknown attribute "x" on the mark "bold"');
    expect(reason(file(doc({ type: "paragraph", surprise: 1 })))).toContain('unknown field "surprise"');
    expect(reason(file(doc(para("x")), { extra: 1 }))).toContain('unknown field "extra"');
    expect(reason(file(doc(para("x")), { meta: { author: "A" } }))).toContain('unknown field "author"');
  });

  it("values the schema does not allow open read-only: colours are palette names, never hex", () => {
    const text = (marks: unknown[]) => ({ type: "paragraph", content: [{ type: "text", text: "x", marks }] });
    expect(reason(file(doc(text([{ type: "textColor", attrs: { color: "#ff0000" } }]))))).toContain('"color"');
    expect(reason(file(doc(text([{ type: "textColor", attrs: { color: "red" } }]))))).toBeNull();
    expect(reason(file(doc(text([{ type: "highlight", attrs: { color: "teal" } }]))))).toContain('"color"');
    expect(reason(file(doc({ type: "heading", attrs: { level: 9 }, content: [] })))).toContain('"level"');
    expect(reason(file(doc({ type: "callout", attrs: { marker: "[!note]", icon: "a very long icon" }, content: [{ type: "calloutTitle" }] })))).toContain('"icon"');
  });

  it("a document that breaks the schema's structure, or a malformed table, opens read-only", () => {
    expect(reason(file(doc({ type: "bulletList", content: [para("not an item")] })))).toContain("not valid");
    expect(reason(file({ type: "doc", content: [] }))).toContain("not valid");
    const cell = (colspan: number) => ({ type: "tableCell", attrs: { colspan }, content: [para("x")] });
    const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
    // The second row is a column short.
    expect(reason(file(doc({ type: "table", content: [row(cell(1), cell(1)), row(cell(1))] })))).toContain("table");
    expect(reason(file(doc({ type: "table", content: [row(cell(1), cell(1)), row(cell(1), cell(1))] })))).toBeNull();
  });

  it("settings that are not ours open read-only", () => {
    expect(reason(file(doc(para("x")), { meta: { width: "huge" } }))).toContain("page width");
    expect(reason(file(doc(para("x")), { meta: { views: { t1: { sort: { column: -1, dir: "asc" } } } } }))).toContain("sort");
    expect(reason(file(doc(para("x")), { meta: { views: { t1: { filter: { column: 0, op: "regex", value: "" } } } } }))).toContain("filter");
    expect(reason(file(doc(para("x")), { meta: { width: "wide", cover: "a.png", title: "T", views: { t1: { sort: { column: 0, dir: "desc" } } } } }))).toBeNull();
  });

  it("a file over the size limit opens read-only without being parsed", () => {
    const big = `{"schemaVersion":1,"pad":"${"x".repeat(SIZE_LIMIT)}"}`;
    expect(oversizeReason(big)).toContain("5,000,000 characters");
    expect(parseEnvelope(big)).toMatchObject({ ok: false });
    expect(oversizeReason("small")).toBeNull();
  });
});

describe("writing a file", () => {
  it("writes sorted keys, two-space indentation, LF and a final line break", () => {
    const text = stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta: { width: "wide", title: "T" }, content: doc(para("a")) } as Envelope);
    expect(text).toBe([
      "{", '  "content": {', '    "content": [', "      {", '        "content": [', "          {", '            "text": "a",', '            "type": "text"', "          }", "        ],",
      '        "type": "paragraph"', "      }", "    ],", '    "type": "doc"', "  },", '  "format": "hivemind-rich",', '  "meta": {', '    "title": "T",', '    "width": "wide"', "  },",
      '  "schemaVersion": 1', "}", "",
    ].join("\n"));
    expect(text).not.toContain("\r");
  });

  it("sorts keys at every depth and keeps array order", () => {
    expect(stable({ b: [{ z: 1, a: 2 }, 3], a: null, c: {}, d: [] })).toBe('{\n  "a": null,\n  "b": [\n    {\n      "a": 2,\n      "z": 1\n    },\n    3\n  ],\n  "c": {},\n  "d": []\n}');
  });

  it("a file in another key order opens and is rewritten in the stable order, with the same content", () => {
    const shuffled = JSON.stringify({ content: doc(para("a")), meta: { width: "full", title: "T" }, format: "hivemind-rich", schemaVersion: 1 });
    const r = inspect(shuffled);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = stringifyDocument(r.doc, r.envelope.meta);
    expect(out).not.toBe(shuffled);
    expect(JSON.parse(out)).toEqual({ ...JSON.parse(shuffled), content: r.doc.toJSON() });
    // A second pass changes nothing: it reopens to the identical bytes.
    const again = inspect(out);
    expect(again.ok && stringifyDocument(again.doc, again.envelope.meta)).toBe(out);
  });

  it("the document writer gives the same text as the envelope writer", () => {
    const content = doc(
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T", marks: [{ type: "bold" }, { type: "textColor", attrs: { color: "red" } }] }] },
      { type: "toggle", attrs: { open: false }, content: [{ type: "toggleSummary", content: [{ type: "text", text: "S" }] }, para("body")] },
      { type: "paragraph" },
    );
    const r = readContent(content);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = { title: "T", views: { t1: { sort: { column: 1, dir: "asc" as const } } } };
    expect(stringifyDocument(r.doc, meta)).toBe(stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta, content: r.doc.toJSON() }));
    // Asked twice, the blocks come from the cache and the text is the same.
    expect(stringifyDocument(r.doc, meta)).toBe(stringifyDocument(r.doc, meta));
  });

  it("a new page is valid, and is one empty paragraph titled by its name", () => {
    const text = newPageText("Untitled 2");
    const r = inspect(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.meta).toEqual({ title: "Untitled 2" });
    expect(r.doc.childCount).toBe(1);
    expect(r.doc.child(0).type.name).toBe("paragraph");
    expect(stringifyDocument(r.doc, r.envelope.meta)).toBe(text);
  });

  it("every document the schema can hold survives a trip through JSON unchanged", () => {
    const schema = hmdocSchema();
    const content = doc(
      { type: "callout", attrs: { marker: "[!tip]-", icon: "★" }, content: [{ type: "calloutTitle", content: [{ type: "text", text: "t" }] }, para("b")] },
      { type: "columns", content: [{ type: "column", content: [para("a")] }, { type: "column", content: [para("b")] }] },
      { type: "table", attrs: { id: "t1" }, content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { background: "blue", colwidth: [90], colspan: 1, rowspan: 1 }, content: [para("x")] }] }] },
    );
    const first = schema.nodeFromJSON(content).toJSON();
    expect(schema.nodeFromJSON(first).toJSON()).toEqual(first);
    const r = readContent(first);
    expect(r.ok).toBe(true);
  });
});
