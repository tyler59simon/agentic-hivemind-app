// NS-3D: the embeds and free-positioned blocks as data: attribute rules, the validator, extraction, export, what pasting
// keeps and a round trip of a page that holds every one.
import { Fragment, Slice } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { isNotebookPath } from "../../../lib/notebooks";
import { stringifyDocument, stringifyEnvelope, type Meta } from "../envelope";
import { extractText } from "../extract";
import { attrAccepts, nodeProblem, RULES } from "../rules";
import { sanitiseSlice } from "../sanitise";
import { hmdocSchema } from "../schema";
import { exportMarkdown, exportText } from "../toMarkdown";
import { inspect, readContent } from "../validate";
import { hashLines } from "./codeRange";
import { EMBED_TYPES } from "./embeds";

const t = (text: string) => ({ type: "text", text });
const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
const frame = (x: number, y: number, ...blocks: unknown[]) => ({ type: "frame", attrs: { x, y, w: 160, h: 64, z: 1 }, content: blocks.length ? blocks : [p()] });
const range = { file: "src/app.ts", from: 3, to: 4, sha256: hashLines(["let a = 1;", "let b = 2;"]), text: "let a = 1;\nlet b = 2;", language: "ts", title: "" };
const GOOD = {
  noteCard: { ref: "sandbox:ab12cd34", title: "Plan note" },
  diagram: { system: "hive", path: "diagrams/c4.svg", title: "C4 overview" },
  codeRange: range,
  pdfPage: { file: "docs/Spec.pdf", page: 4, title: "" },
  gallery: { images: ["pics/a.png", "pics/b one.png"], columns: 2, title: "Shots" },
  excalidraw: { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png", title: "Sketch" },
};
const embed = (type: keyof typeof GOOD, over: Record<string, unknown> = {}) => ({ type, attrs: { ...GOOD[type], ...over } });
const free = (...frames: unknown[]) => ({ type: "freeform", attrs: { height: 240 }, content: frames });
const page = (...blocks: unknown[]) => ({ type: "doc", content: blocks });
const everything = () => page(
  { type: "heading", attrs: { level: 1 }, content: [t("Embeds")] },
  ...EMBED_TYPES.map((k) => embed(k)),
  free(frame(200, 16, p(t("Top right"))), frame(16, 120, p(t("Bottom left"))), frame(16, 16, p(t("Top left")))),
  p(t("The end")),
);
const verdict = (content: unknown) => { const r = readContent(content); return r.ok ? "ok" : r.reason; };
const fileOf = (content: unknown, meta: Meta = {}) => stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta, content: content as never });

describe("paths from the notebook's root", () => {
  it("accepts plain relative paths, spaces and non-ASCII names included", () => {
    for (const ok of ["a.png", "pics/a.png", "Notes/My pictures/a b.png", "attachments/Drawing 20261121-153012.png", "dossiers/é.pdf", "a/b/c/d.txt"]) expect(isNotebookPath(ok), ok).toBe(true);
  });

  it("refuses a path that climbs out, is absolute, has a hidden part or a name Windows does not allow", () => {
    const bad = [
      "", "../a.png", "a/../b.png", "a/..", "..", ".", "./a.png", "a/./b.png", "/a.png", "//server/share/a.png", "C:/a.png", "C:\\a.png", "a\\b.png",
      ".git/config", "docs/.hidden/a.png", ".hivemind/trash/a.png", "a//b.png", "a/", "a.png.", "a.png ", "a/b?.png", "a/b*.png", "a/b|c.png", 'a/"b".png', "a/<b>.png",
      "a\u0000b.png", "a\nb.png", "x".repeat(241), `${"a/".repeat(600)}b.png`,
    ];
    for (const path of bad) expect(isNotebookPath(path), JSON.stringify(path)).toBe(false);
    for (const nonText of [null, undefined, 5, {}, ["a.png"], true]) expect(isNotebookPath(nonText)).toBe(false);
  });
});

describe("attribute rules", () => {
  const cases: [string, unknown[], unknown[]][] = [
    ["noteCard.ref", ["sandbox:ab12", "ab12cd34-ef56", "A note's exact title"], ["", "   ", "a\nb", 5, null, "x".repeat(201), "-x", "--help", "  -a:b", "-"]],
    ["noteCard.title", ["", "A title"], ["a\nb", 5, "x".repeat(301)]],
    ["diagram.system", ["hive", "a1-b2", "a"], ["", "Hive", "-a", "a b", "x".repeat(41), "../a", 3]],
    ["diagram.path", ["diagrams/c4.svg", "a.png", "views/level 1.svg"], ["", "../a.svg", "a/../b.svg", "/a.svg", "C:/a.svg", "a\\b.svg", "a//b.svg", "a\nb.svg", 4]],
    ["codeRange.file", ["src/a.ts", "a.rs"], ["", "../a.ts", "/a.ts", ".git/config", "C:/a.ts", "a\\b.ts"]],
    ["codeRange.from", [1, 20, 10_000_000], [0, -1, 1.5, "1", null, 10_000_001]],
    ["codeRange.to", [1, 200], [0, 2.5, "2", 10_000_001]],
    ["codeRange.sha256", ["a".repeat(64), "0123456789abcdef".repeat(4)], ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 5]],
    ["codeRange.text", ["", "a", "a\nb", Array.from({ length: 200 }, () => "x").join("\n")], [Array.from({ length: 201 }, () => "x").join("\n"), "x".repeat(20_001), 5]],
    ["codeRange.language", ["", "ts", "c++"], ["a\nb", "x".repeat(41), 3]],
    ["pdfPage.file", ["Spec.pdf", "docs/Spec.PDF"], ["", "Spec.png", "../Spec.pdf", "/Spec.pdf", "docs/.h/Spec.pdf", "a:b.pdf"]],
    ["pdfPage.page", [1, 4, 100_000], [0, -2, 1.2, "3", 100_001]],
    ["gallery.images", [["a.png"], ["a.png", "pics/b.JPG", "c.webp"]], [[], "a.png", ["a.pdf"], ["../a.png"], ["/a.png"], ["a.png", ".x/b.png"], [3], Array.from({ length: 61 }, (_, i) => `p${i}.png`)]],
    ["gallery.columns", [2, 3, 4], [1, 5, 0, 2.5, "3"]],
    ["excalidraw.scene", ["Sketch.excalidraw", "attachments/Sketch 1.excalidraw"], ["", "Sketch.json", "../S.excalidraw", "/S.excalidraw", ".x/S.excalidraw", "a\\S.excalidraw"]],
    ["excalidraw.preview", ["Sketch.png", "attachments/Sketch 1.png"], ["", "Sketch.jpg", "../S.png", "/S.png", "C:/S.png", ".x/S.png"]],
    ["freeform.height", [0, 240, 100_000], [-1, 100_001, 1.5, "240"]],
    ["frame.x", [0, 16, 100_000], [-8, 1.5, "0", 100_001]],
    ["frame.y", [0, 16], [-8, 0.5]],
    ["frame.w", [1, 160], [0, -4, 1.5]],
    ["frame.h", [1, 64], [0, 3.5]],
    ["frame.z", [0, 1, 100_000], [-1, 1.5]],
  ];
  for (const [key, good, bad] of cases) {
    it(`${key}`, () => {
      const [type, attr] = key.split(".");
      for (const v of good) expect(attrAccepts(type, attr, v), `${key} accepts ${JSON.stringify(v)?.slice(0, 40)}`).toBe(true);
      for (const v of bad) expect(attrAccepts(type, attr, v), `${key} refuses ${JSON.stringify(v)?.slice(0, 40)}`).toBe(false);
    });
  }

  it("every attribute of every new node has a rule", () => {
    const schema = hmdocSchema();
    for (const name of [...EMBED_TYPES, "freeform", "frame"]) {
      for (const attr of Object.keys(schema.nodes[name].spec.attrs ?? {})) expect(RULES[`${name}.${attr}`], `${name}.${attr}`).toBeTypeOf("function");
    }
  });

  it("title is one line of at most 300 characters on every embed", () => {
    for (const type of EMBED_TYPES) {
      expect(attrAccepts(type, "title", "ok")).toBe(true);
      expect(attrAccepts(type, "title", "two\nlines")).toBe(false);
    }
  });
});

describe("what makes a node refused as a whole", () => {
  it("a range that ends before it starts, or holds more than 200 lines", () => {
    expect(nodeProblem("codeRange", { ...range })).toBeNull();
    expect(nodeProblem("codeRange", { ...range, from: 9, to: 4 })).toContain("ends before it starts");
    expect(nodeProblem("codeRange", { ...range, from: 1, to: 201 })).toContain("more than 200 lines");
    expect(nodeProblem("codeRange", { ...range, from: 1, to: 200 })).toBeNull();
  });

  it("an embed left at its defaults, which are not real values", () => {
    for (const type of EMBED_TYPES) {
      const defaults = Object.fromEntries(Object.entries(hmdocSchema().nodes[type].spec.attrs ?? {}).map(([k, v]) => [k, (v as { default: unknown }).default]));
      expect(nodeProblem(type, defaults), type).not.toBeNull();
    }
  });

  it("is not asked of other nodes", () => {
    expect(nodeProblem("paragraph", {})).toBeNull();
  });
});

describe("the validator", () => {
  it("opens a page with every embed and a free-positioned block", () => {
    expect(verdict(everything())).toBe("ok");
  });

  it("refuses an embed with a path that climbs out of the notebook, is absolute or hidden", () => {
    for (const bad of ["../x.pdf", "/x.pdf", "C:/x.pdf", ".git/x.pdf", "a\\x.pdf"]) {
      expect(verdict(page(embed("pdfPage", { file: bad }))), bad).toContain("does not accept");
    }
    expect(verdict(page(embed("gallery", { images: ["a.png", "../b.png"] })))).toContain("does not accept");
    expect(verdict(page(embed("excalidraw", { preview: "/p.png" })))).toContain("does not accept");
    expect(verdict(page(embed("codeRange", { file: "../a.ts" })))).toContain("does not accept");
  });

  it("refuses an embed that leaves out what it needs, though Tiptap would build it from defaults", () => {
    for (const type of EMBED_TYPES) {
      const reason = verdict(page({ type, attrs: {} }));
      expect(reason, type).toContain("read-only");
      expect(reason, type).toContain(type);
    }
    expect(verdict(page({ type: "freeform", content: [{ type: "frame", content: [p()] }] }))).toBe("ok");
  });

  it("refuses an attribute it does not know, and an unknown embed", () => {
    expect(verdict(page(embed("noteCard", { extra: 1 })))).toContain('unknown attribute "extra"');
    expect(verdict(page({ type: "videoCard", attrs: {} }))).toContain('unknown node "videoCard"');
  });

  it("refuses a range of the wrong shape", () => {
    expect(verdict(page(embed("codeRange", { from: 9, to: 4 })))).toContain("ends before it starts");
  });

  it("refuses a free-positioned block inside a frame, however deep, and a frame outside a block", () => {
    const inner = free(frame(0, 0));
    expect(verdict(page(free(frame(0, 0, inner))))).toContain("free-positioned block inside a frame");
    expect(verdict(page(free(frame(0, 0, { type: "columns", content: [{ type: "column", content: [inner] }, { type: "column", content: [p()] }] }))))).toContain("free-positioned block inside a frame");
    // A block beside a frame, or in a column outside any frame, is fine.
    expect(verdict(page({ type: "columns", content: [{ type: "column", content: [inner] }, { type: "column", content: [p()] }] }))).toBe("ok");
    expect(verdict(page({ type: "frame", attrs: { x: 0, y: 0, w: 9, h: 9, z: 1 }, content: [p()] }))).toContain("read-only");
    expect(verdict(page(free()))).toContain("read-only");
  });

  it("embeds may sit inside columns, toggles, callouts, table cells and frames", () => {
    const wrapped = page(
      { type: "columns", content: [{ type: "column", content: [embed("gallery")] }, { type: "column", content: [embed("pdfPage")] }] },
      { type: "toggle", attrs: { open: true }, content: [{ type: "toggleSummary", content: [t("S")] }, embed("codeRange")] },
      free(frame(0, 0, embed("excalidraw"), embed("noteCard"))),
    );
    expect(verdict(wrapped)).toBe("ok");
  });
});

describe("extraction", () => {
  const text = (...blocks: unknown[]) => extractText(page(...blocks));

  it("gives each embed its title; an untitled one gives nothing", () => {
    expect(text(embed("noteCard"))).toBe("Plan note");
    expect(text(embed("diagram"))).toBe("C4 overview");
    expect(text(embed("pdfPage", { title: "Section 4" }))).toBe("Section 4");
    expect(text(embed("pdfPage"))).toBe("");
    expect(text(embed("excalidraw"))).toBe("Sketch");
    expect(text(embed("excalidraw", { title: "  " }))).toBe("");
  });

  it("adds the stored lines of a code range and the paths of a gallery's pictures", () => {
    expect(text(embed("codeRange", { title: "Adding" }))).toBe("Adding\nlet a = 1;\nlet b = 2;");
    expect(text(embed("codeRange"))).toBe("let a = 1;\nlet b = 2;");
    expect(text(embed("gallery"))).toBe("Shots\npics/a.png\npics/b one.png");
    expect(text(embed("gallery", { title: "" }))).toBe("pics/a.png\npics/b one.png");
  });

  it("reads the frames of a free-positioned block top to bottom, then left to right, whatever order they are stored in", () => {
    expect(text(free(frame(200, 16, p(t("c"))), frame(16, 120, p(t("d"))), frame(16, 16, p(t("a"))), frame(200, 16, p(t("c2"))), frame(100, 16, p(t("b")))))).toBe("a\nb\nc\nc2\nd");
  });

  it("reads the blocks inside a frame, embeds included", () => {
    expect(text(free(frame(0, 0, p(t("one")), embed("noteCard"), p(t("two")))))).toBe("one\nPlan note\ntwo");
  });

  it("the whole page, in document order", () => {
    expect(extractText(everything())).toBe([
      "Embeds", "Plan note", "C4 overview", "let a = 1;", "let b = 2;", "Shots", "pics/a.png", "pics/b one.png", "Sketch",
      "Top left", "Top right", "Bottom left", "The end",
    ].join("\n"));
  });
});

describe("export to Markdown", () => {
  const out = (blocks: unknown[], folder = "") => {
    const read = readContent(page(...blocks));
    if (!read.ok) throw new Error(read.reason);
    return exportMarkdown(read.doc, {}, folder);
  };
  const counts = (blocks: unknown[], folder = "") => Object.fromEntries(out(blocks, folder).report.map((r) => [r.key, r.count]));

  it("writes a note card as a line with its title and reference", () => {
    expect(out([embed("noteCard")]).text).toBe("Memory note: Plan note (`sandbox:ab12cd34`)\n");
    expect(out([embed("noteCard", { title: "" })]).text).toBe("Memory note: sandbox:ab12cd34 (`sandbox:ab12cd34`)\n");
  });

  it("writes a diagram as a line naming it", () => {
    expect(out([embed("diagram")]).text).toBe("Architecture diagram: C4 overview (system hive, `diagrams/c4.svg`)\n");
  });

  it("writes a code range as a fenced block of its stored lines under a file:from-to line", () => {
    expect(out([embed("codeRange")]).text).toBe("`src/app.ts:3-4`\n\n```ts\nlet a = 1;\nlet b = 2;\n```\n");
    expect(out([embed("codeRange", { title: "Adding", language: "" })]).text).toBe("Adding: `src/app.ts:3-4`\n\n```\nlet a = 1;\nlet b = 2;\n```\n");
    expect(out([embed("codeRange", { from: 5, to: 5, text: "", sha256: hashLines([""]) })]).text).toContain("`src/app.ts:5`");
  });

  it("writes a PDF page as a link to the file and page, from the folder of the page", () => {
    expect(out([embed("pdfPage")]).text).toBe("[Spec, page 4](docs/Spec.pdf#page=4)\n");
    expect(out([embed("pdfPage", { title: "Section 4" })], "docs").text).toBe("[Section 4](Spec.pdf#page=4)\n");
    expect(out([embed("pdfPage")], "notes/2026").text).toBe("[Spec, page 4](../../docs/Spec.pdf#page=4)\n");
  });

  it("writes a gallery as its pictures, one after another, under its title", () => {
    expect(out([embed("gallery")]).text).toBe("Shots\n\n![a](pics/a.png)\n\n![b one](<pics/b one.png>)\n");
    expect(out([embed("gallery", { title: "" })], "pics").text).toBe("![a](a.png)\n\n![b one](<b one.png>)\n");
  });

  it("writes a drawing as its preview picture", () => {
    expect(out([embed("excalidraw")]).text).toBe("![Sketch](attachments/Sketch.png)\n");
    expect(out([embed("excalidraw", { title: "" })], "attachments").text).toBe("![Sketch](Sketch.png)\n");
  });

  it("writes the frames of a free-positioned block one after another in reading order", () => {
    expect(out([free(frame(200, 16, p(t("c"))), frame(16, 120, p(t("d"))), frame(16, 16, p(t("a"))))]).text).toBe("a\n\nc\n\nd\n");
  });

  it("an embed in a table cell is written in the cell and counted once", () => {
    const cell = (type: string, ...blocks: unknown[]) => ({ type, content: blocks });
    const table = { type: "table", attrs: { id: "t" }, content: [
      { type: "tableRow", content: [cell("tableHeader", p(t("a"))), cell("tableHeader", p(t("b")))] },
      { type: "tableRow", content: [cell("tableCell", embed("noteCard")), cell("tableCell", embed("codeRange"), free(frame(0, 0, p(t("in frame")))))] },
    ] };
    const done = out([table]);
    expect(done.text).toContain("Memory note: Plan note (`sandbox:ab12cd34`)");
    expect(done.text).toContain("`src/app.ts:3-4`");
    expect(done.text).toContain("`let a = 1;`<br>`let b = 2;`");
    expect(done.text).toContain("in frame");
    expect(counts([table])).toMatchObject({ noteCards: 1, codeRanges: 1, freeform: 1, richCells: 2 });
  });

  it("the report counts each kind", () => {
    expect(counts([embed("noteCard"), embed("noteCard", { ref: "x:1" }), embed("diagram"), embed("codeRange"), embed("pdfPage"), embed("gallery"), embed("excalidraw"), embed("excalidraw", { scene: "b.excalidraw", preview: "b.png" }), free(frame(0, 0)), free(frame(0, 0), frame(8, 8))]))
      .toEqual({ noteCards: 2, diagrams: 1, codeRanges: 1, pdfPages: 1, galleries: 1, drawings: 2, freeform: 2 });
    expect(out([p(t("plain"))]).report).toEqual([]);
  });

  it("exportText takes the folder of the page, and writes what the page's file holds", () => {
    const text = fileOf(page(embed("pdfPage"), embed("excalidraw")));
    const done = exportText(text, "notes");
    expect(done.ok && done.markdown).toBe("[Spec, page 4](../docs/Spec.pdf#page=4)\n\n![Sketch](../attachments/Sketch.png)\n");
    expect(done.ok && done.report.map((r) => r.key)).toEqual(["pdfPages", "drawings"]);
  });
});

describe("what a pasted slice keeps", () => {
  const schema = hmdocSchema();
  const slice = (...blocks: unknown[]) => new Slice(Fragment.from(blocks.map((b) => schema.nodeFromJSON(b))), 0, 0);
  const names = (s: Slice) => { const out: string[] = []; s.content.forEach((n) => out.push(n.type.name)); return out; };

  it("keeps an embed whose attributes pass the rules, as the same node", () => {
    const s = slice(embed("pdfPage"), embed("gallery"), embed("codeRange"));
    expect(sanitiseSlice(s)).toBe(s);
  });

  it("leaves out an embed with a path that climbs out, is absolute or hidden, whatever else is in the slice", () => {
    for (const bad of ["../x.pdf", "/x.pdf", "C:/x.pdf", ".git/x.pdf", "a/../../x.pdf"]) {
      const out = sanitiseSlice(slice(p(t("before")), embed("pdfPage", { file: bad }), p(t("after"))));
      expect(names(out), bad).toEqual(["paragraph", "paragraph"]);
    }
    expect(names(sanitiseSlice(slice(embed("gallery", { images: ["a.png", "../b.png"] }), embed("excalidraw", { scene: "x.json" }), embed("noteCard", { ref: "" }))))).toEqual([]);
    expect(names(sanitiseSlice(slice(embed("codeRange", { from: 9, to: 4 }))))).toEqual([]);
  });

  it("a free-positioned block pasted inside a frame is left out, and the frame is filled again", () => {
    const wrapped = slice(free(frame(0, 0, free(frame(0, 0, p(t("deep")))))));
    const out = sanitiseSlice(wrapped);
    const doc = schema.nodes.doc.create(null, out.content);
    doc.check();
    expect(doc.textContent).toBe("");
    expect(holds(doc, "freeform")).toBe(1);
    expect(holds(doc, "frame")).toBe(1);
    // A free-positioned block of its own is kept.
    const own = slice(free(frame(0, 0, p(t("kept")))));
    expect(sanitiseSlice(own)).toBe(own);
  });

  it("a frame with a refused number gets the default, and the block is still a page the validator accepts", () => {
    const bad = schema.nodes.freeform.create({ height: 240 }, [schema.nodes.frame.create({ x: -5, y: 1.5, w: 0, h: "9", z: 1 }, [schema.nodes.paragraph.create()])]);
    const out = sanitiseSlice(new Slice(Fragment.from(bad), 0, 0));
    const doc = schema.nodes.doc.create(null, out.content);
    expect(verdict(doc.toJSON())).toBe("ok");
    expect(doc.firstChild!.firstChild!.attrs).toEqual({ x: 16, y: 16, w: 320, h: 96, z: 1 });
  });
});

function holds(node: { descendants: (f: (n: { type: { name: string } }) => boolean) => void }, name: string): number {
  let n = 0;
  node.descendants((c) => { if (c.type.name === name) n++; return true; });
  return n;
}

describe("a round trip", () => {
  it("a page with every embed, written by stringifyDocument, reopens identically", () => {
    const meta: Meta = { title: "Embeds", width: "wide" };
    const first = readContent(everything());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const text = stringifyDocument(first.doc, meta);
    const again = inspect(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.doc.eq(first.doc)).toBe(true);
    expect(again.envelope.meta).toEqual(meta);
    // And writing the reopened page gives the same file, byte for byte.
    expect(stringifyDocument(again.doc, again.envelope.meta)).toBe(text);
    // Every kind of embed is in it, with its attributes.
    const found = new Set<string>();
    again.doc.descendants((n) => { found.add(n.type.name); return true; });
    for (const type of [...EMBED_TYPES, "freeform", "frame"]) expect(found.has(type), type).toBe(true);
    expect(JSON.parse(text).content.content[3].attrs).toEqual(range);
  });

  it("the frames keep the order they were stored in", () => {
    const read = readContent(page(free(frame(200, 16, p(t("c"))), frame(16, 16, p(t("a"))))));
    if (!read.ok) throw new Error(read.reason);
    const again = inspect(stringifyDocument(read.doc, {}));
    expect(again.ok && extractText(again.doc.toJSON())).toBe("a\nc");
    expect(again.ok && again.doc.firstChild!.child(0).attrs.x).toBe(200);
  });
});
