// NS-3B corpus: the four assertions of the phase document (identity, locality, per-block fidelity; the mode switch is
// in RichEditor.test.tsx), run on the hand-made corpus, this repository's docs and Living Memory note fixtures, in LF,
// CRLF, BOM and no-final-newline variants through the Living Memory page adapter.
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { pageBody, pageText } from "../../documents/adapters/lmdoc";
import notes from "../../lib/__fixtures__/note-format.json";
import { sameMarkdown } from "./canon";
import { loadPage } from "./fromMarkdown";
import { parse } from "./markdown";
import { serialize } from "./preserve";
import { richSchema } from "./schema";

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const corpus = import.meta.glob("./corpus/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const docs = import.meta.glob("/docs/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixtures = Object.fromEntries((notes as { cases: { name: string; raw: string }[] }).cases.map((c) => [`note:${c.name}`, c.raw]));
const pages: Record<string, string> = Object.fromEntries(Object.entries({ ...corpus, ...docs, ...fixtures }).map(([k, v]) => [k, lf(v)]));
const handmade = Object.keys(corpus);
/** Real pages for the slower edit checks: the Notes Studio overview and two phase documents. */
const SOME_DOCS = ["/docs/notes-studio/README.md", "/docs/notes-studio/phase-3a-live-preview.md", "/docs/engineering-workspace.md"];

const schema = richSchema();

/** The page through the adapter: bytes in, editor text, Rich document, editor text, bytes out. */
function through(raw: string): string {
  const { text, format } = pageText(raw);
  const { doc, original } = loadPage(schema, text);
  return pageBody(serialize(doc, original), format);
}

const VARIANTS: [string, (s: string) => string][] = [
  ["LF", (s) => s],
  ["CRLF", (s) => s.replace(/\n/g, "\r\n")],
  ["BOM", (s) => `﻿${s}`],
  ["no final newline", (s) => s.replace(/\n+$/, "")],
  ["CRLF with BOM and no final newline", (s) => `﻿${s.replace(/\n+$/, "").replace(/\n/g, "\r\n")}`],
];

describe("identity: an untouched page is written back byte for byte", () => {
  it.each(Object.keys(pages))("%s", (name) => {
    // Docs pages run in LF and the combined variant; the hand-made corpus and the note fixtures in every variant.
    const variants = name.startsWith("/docs/") ? [VARIANTS[0], VARIANTS[4]] : VARIANTS;
    for (const [variant, make] of variants) {
      const raw = make(pages[name]);
      expect(through(raw), variant).toBe(raw);
    }
  });

  it("a page with mixed line endings opens read-only, so Rich never writes it", () => {
    expect(pageText("a\r\nb\nc").readOnly).toMatch(/mixes line-ending/);
  });

  it("a page over 1 MB", () => {
    let big = "";
    const all = Object.values(pages).join("\n\n");
    while (big.length < 1_000_000) big += `${all}\n\n`;
    const started = performance.now();
    const { doc, original } = loadPage(schema, big);
    const loaded = performance.now();
    expect(serialize(doc, original)).toBe(big);
    // Printed for the phase record; the budget is checked in the UI pass.
    console.info(`1 MB page: load ${Math.round(loaded - started)} ms, write ${Math.round(performance.now() - loaded)} ms`);
  });

  it("empty and blank pages", () => {
    for (const raw of ["", "\n", "\n\n\n", "   \n"]) expect(through(raw)).toBe(raw);
  });
});

/** Up to `max` block indexes spread over the page. */
const sample = (count: number, max = 24) => (count <= max ? [...Array(count).keys()] : Array.from({ length: max }, (_, i) => Math.floor((i * count) / max)));

const children = (doc: PMNode) => { const out: PMNode[] = []; doc.forEach((n) => out.push(n)); return out; };
const withChild = (doc: PMNode, k: number, n: PMNode) => doc.type.create(doc.attrs, children(doc).map((c, i) => (i === k ? n : c)));

/** The block with an `x` typed at the end of its first text, or null when it has no text to type into. */
function typed(n: PMNode): PMNode | null {
  let done = false;
  const walk = (node: PMNode): PMNode => {
    if (done) return node;
    if (node.isText) { done = true; return schema.text(`${node.text}x`, node.marks); }
    if (node.isLeaf) return node;
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(walk(c)));
    return node.type.create(node.attrs, kids, node.marks);
  };
  const out = walk(n);
  return done ? out : null;
}

const slicesOf = (text: string) => parse(text).children.map((c) => text.slice(c.position!.start.offset!, c.position!.end.offset!));

describe("locality: an edit to one block leaves every other block byte-identical", () => {
  it.each(handmade.concat(SOME_DOCS))("%s", (name) => {
    const text = pages[name];
    const { doc, original } = loadPage(schema, text);
    const before = slicesOf(text);
    for (const k of sample(doc.childCount)) {
      const edited = typed(doc.child(k));
      if (!edited || edited.type.name === "rawBlock") continue;
      const after = slicesOf(serialize(withChild(doc, k, edited), original));
      expect(after.length, `block ${k}`).toBe(before.length);
      after.forEach((s, j) => { if (j !== k) expect(s, `block ${j} after editing ${k}`).toBe(before[j]); });
    }
  });
});

describe("per-block fidelity: a block forced through the writer reads back as the same block", () => {
  it.each(handmade.concat(SOME_DOCS, Object.keys(fixtures)))("%s", (name) => {
    const text = pages[name];
    const { doc, original } = loadPage(schema, text);
    const tree = parse(text).children;
    const before = slicesOf(text);
    for (const k of sample(doc.childCount)) {
      const n = doc.child(k);
      const fresh = n.type.create({ ...n.attrs, srcId: null }, n.content, n.marks);
      const out = serialize(withChild(doc, k, fresh), original);
      const back = parse(out).children;
      expect(back.length, `block ${k} of ${name}`).toBe(tree.length);
      expect(sameMarkdown(back[k], tree[k]), `block ${k}: ${before[k].slice(0, 80)}`).toBe(true);
      const after = slicesOf(out);
      after.forEach((s, j) => { if (j !== k) expect(s, `block ${j} after writing ${k}`).toBe(before[j]); });
    }
  });

  it("every block of the hand-made corpus is editable, not a source box, unless it is source by nature", () => {
    const boxed: string[] = [];
    for (const name of handmade) {
      const { doc } = loadPage(schema, pages[name]);
      doc.forEach((n) => { if (n.type.name === "rawBlock" && !["html", "definition", "frontmatter"].includes(n.attrs.kind)) boxed.push(`${name}: ${n.attrs.value.slice(0, 60)}`); });
    }
    expect(boxed).toEqual([]);
  });
});
