// NS-3B corpus, kept for the .hmdoc editor and its Markdown export after Rich mode for Markdown was deleted (CON-19):
// every block read from the hand-made corpus, this repository's docs and Living Memory note fixtures, written alone by
// writeBlock, reads back as the same block; and the hand-made corpus loads as editable blocks.
import { describe, expect, it } from "vitest";
import notes from "../../lib/__fixtures__/note-format.json";
import { sameMarkdown } from "./canon";
import { loadPage } from "./fromMarkdown";
import { parse } from "./markdown";
import { writeBlock } from "./toMarkdown";
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

/** Up to `max` block indexes spread over the page. */
const sample = (count: number, max = 24) => (count <= max ? [...Array(count).keys()] : Array.from({ length: max }, (_, i) => Math.floor((i * count) / max)));

const slicesOf = (text: string) => parse(text).children.map((c) => text.slice(c.position!.start.offset!, c.position!.end.offset!));

describe("per-block fidelity: a block forced through the writer reads back as the same block", () => {
  it.each(handmade.concat(SOME_DOCS, Object.keys(fixtures)))("%s", (name) => {
    const text = pages[name];
    const { doc, original } = loadPage(schema, text);
    const tree = parse(text).children;
    const before = slicesOf(text);
    for (const k of sample(doc.childCount)) {
      const n = doc.child(k);
      const fresh = n.type.create({ ...n.attrs, srcId: null }, n.content, n.marks);
      // The page with block k written fresh and every other block and gap as it was.
      const { from, to } = original.slices[k];
      const out = original.source.slice(0, from) + writeBlock(fresh, original.style, original.definitions) + original.source.slice(to);
      const back = parse(out).children;
      expect(back.length, `block ${k} of ${name}`).toBe(tree.length);
      expect(sameMarkdown(back[k], tree[k]), `block ${k}: ${before[k].slice(0, 80)}`).toBe(true);
      const after = slicesOf(out);
      after.forEach((s, j) => { if (j !== k) expect(s, `block ${j} after writing ${k}`).toBe(before[j]); });
    }
  }, 20_000);

  it("every block of the hand-made corpus is editable, not a source box, unless it is source by nature", () => {
    const boxed: string[] = [];
    for (const name of handmade) {
      const { doc } = loadPage(schema, pages[name]);
      doc.forEach((n) => { if (n.type.name === "rawBlock" && !["html", "definition", "frontmatter"].includes(n.attrs.kind)) boxed.push(`${name}: ${n.attrs.value.slice(0, 60)}`); });
    }
    expect(boxed).toEqual([]);
  });
});
