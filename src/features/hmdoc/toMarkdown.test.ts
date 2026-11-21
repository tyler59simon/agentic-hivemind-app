// NS-3C: Export to Markdown and Convert to rich page. The report lists everything the Markdown could not keep, and a
// test fails when the schema holds a node, mark or attribute the export does not account for.
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { convertMarkdown, markdownToRichDoc } from "./convert";
import { inspect } from "./validate";
import { richSchema } from "../rich/schema";
import { attrsOf, hmdocSchema } from "./schema";
import { CLASSIFIED, REPORT_LABELS, exportMarkdown, exportText, type ReportKey } from "./toMarkdown";
import type { Meta } from "./envelope";

const t = (text: string, marks?: unknown[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
const cell = (type: string, blocks: unknown[], attrs?: Record<string, unknown>) => ({ type, ...(attrs ? { attrs } : {}), content: blocks });
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const doc = (...blocks: unknown[]): PMNode => {
  const d = hmdocSchema().nodeFromJSON({ type: "doc", content: blocks });
  d.check();
  return d;
};
const counts = (report: { key: ReportKey; count: number }[]) => Object.fromEntries(report.map((r) => [r.key, r.count]));

/** A page that uses every construct only the rich page has. */
function everything(): { doc: PMNode; meta: Meta } {
  const table = {
    type: "table", attrs: { id: "t1", align: [null, "right", null] }, content: [
      row(cell("tableHeader", [p(t("Item"))], { colwidth: [120] }), cell("tableHeader", [p(t("Qty"))]), cell("tableHeader", [p(t("Total"))])),
      row(cell("tableHeader", [p(t("Pens"))], { colwidth: [120] }), cell("tableCell", [p(t("3"))], { background: "green" }), cell("tableCell", [p(t("=B2*2"))])),
      row(cell("tableHeader", [p(t("Pads"))], { colwidth: [120] }), cell("tableCell", [p(t("one")), p(t("two"))]), cell("tableCell", [{ type: "bulletList", content: [{ type: "listItem", content: [p(t("x"))] }, { type: "listItem", content: [p(t("y"))] }] }])),
      row(cell("tableHeader", [p(t("Sum"))], { colwidth: [120] }), cell("tableCell", [p(t("=SUM(B2, 40)"))], { colspan: 2 })),
    ],
  };
  return {
    doc: doc(
      { type: "heading", attrs: { level: 1 }, content: [t("Plan")] },
      p(t("red text", [{ type: "textColor", attrs: { color: "red" } }]), t(" "), t("blue mark", [{ type: "highlight", attrs: { color: "blue" } }]), t(" "), t("plain mark", [{ type: "highlight", attrs: { color: "yellow" } }])),
      { type: "callout", attrs: { marker: "[!tip]", icon: "★" }, content: [{ type: "calloutTitle", content: [t("Hint")] }, p(t("Body"))] },
      { type: "toggle", attrs: { open: false }, content: [{ type: "toggleSummary", content: [t("More")] }, p(t("Hidden"))] },
      { type: "columns", content: [{ type: "column", content: [p(t("Left"))] }, { type: "column", content: [p(t("Right"))] }] },
      table,
    ),
    meta: { title: "Plan", cover: "assets/cover.png", width: "full", views: { t1: { sort: { column: 1, dir: "asc" }, filter: { column: 0, op: "contains", value: "P" } }, gone: { sort: { column: 0, dir: "asc" } } } },
  };
}

describe("export to Markdown", () => {
  it("writes the page's content, flattening what Markdown cannot hold", () => {
    const { doc: d, meta } = everything();
    const { text } = exportMarkdown(d, meta);
    expect(text).toContain("# Plan");
    expect(text).toContain("==blue mark==");
    expect(text).toContain("==plain mark==");
    expect(text).toContain("red text");
    expect(text).toContain("> [!tip]");
    // A toggle is a folded callout whose title is the summary; the body follows.
    expect(text).toContain("> [!note]- More\n> Hidden");
    // Columns one after another.
    expect(text.indexOf("Left")).toBeGreaterThan(-1);
    expect(text.indexOf("Right")).toBeGreaterThan(text.indexOf("Left"));
    // The table: formulas as values, a merged cell's content in its first cell, a cell of several blocks joined with <br>.
    expect(text).toMatch(/\| Item \| +Qty \| Total +\|/);
    expect(text).toMatch(/\| 6 +\|/);
    expect(text).toContain("one<br>two");
    expect(text).toContain("x<br>y");
    expect(text).toMatch(/\| +43 \|/);
    expect(text).not.toContain("=B2");
    expect(text.endsWith("\n")).toBe(true);
    // What it writes is Markdown this app reads back as a table of the same size.
    expect(text.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(5);
  });

  it("the report counts each thing the page lost", () => {
    const { doc: d, meta } = everything();
    const { report } = exportMarkdown(d, meta);
    expect(counts(report)).toEqual({
      mergedCells: 1, richCells: 2, cellBackgrounds: 1, columnWidths: 1, headerColumns: 1, textColours: 1, highlightColours: 1,
      columns: 1, toggles: 1, calloutIcons: 1, formulas: 2, cover: 1, width: 1, views: 1,
    });
    // In the order the report lists them, each with its words.
    expect(report.map((r) => r.key)).toEqual(Object.keys(REPORT_LABELS));
    expect(report.every((r) => r.label === REPORT_LABELS[r.key] && r.count > 0)).toBe(true);
  });

  it("a page with nothing the Markdown cannot hold has an empty report", () => {
    const d = doc(
      { type: "heading", attrs: { level: 2 }, content: [t("Title")] }, p(t("Some "), t("bold", [{ type: "bold" }]), t(" text.")),
      { type: "table", attrs: { id: "t1" }, content: [row(cell("tableHeader", [p(t("a"))]), cell("tableHeader", [p(t("b"))])), row(cell("tableCell", [p(t("1"))]), cell("tableCell", [p(t("2"))]))] },
    );
    const out = exportMarkdown(d, { title: "T", width: "normal" });
    expect(out.report).toEqual([]);
    expect(out.text).toBe("## Title\n\nSome **bold** text.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  });

  it("a cell of one paragraph, and an empty paragraph beside it, is not reported", () => {
    const d = doc({ type: "table", attrs: { id: "t" }, content: [row(cell("tableHeader", [p(t("a")), p()]), cell("tableHeader", [p(t("b"))])), row(cell("tableCell", [p(t("1"))]), cell("tableCell", [p()]))] });
    expect(exportMarkdown(d).report).toEqual([]);
  });

  it("views of tables no longer in the page, and a normal width, are not reported", () => {
    const d = doc(p(t("x")));
    expect(exportMarkdown(d, { width: "normal", views: { t1: { sort: { column: 0, dir: "asc" } } } }).report).toEqual([]);
  });

  it("exports a file's text, and says why a file that is not ours cannot be exported", () => {
    const { doc: d, meta } = everything();
    const text = JSON.stringify({ schemaVersion: 1, format: "hivemind-rich", meta, content: d.toJSON() });
    const ok = exportText(text);
    expect(ok.ok && ok.report.length).toBe(14);
    const bad = exportText("{}");
    expect(bad.ok).toBe(false);
  });

  it("keeps source boxes, links, footnotes and Obsidian syntax as written", () => {
    const d = doc(
      { type: "rawBlock", attrs: { kind: "frontmatter", value: "---\ntitle: X\n---" } },
      p(t("See "), { type: "wikiLink", attrs: { value: "Other|alias" } }, t(" and "), t("site", [{ type: "link", attrs: { href: "https://example.com", title: null } }]), { type: "footnoteRef", attrs: { identifier: "1", label: null } }, t(" "), { type: "rawInline", attrs: { kind: "comment", value: "%%note%%" } }),
      { type: "footnoteDef", attrs: { identifier: "1" }, content: [p(t("The note."))] },
    );
    expect(exportMarkdown(d).text).toBe("---\ntitle: X\n---\n\nSee [[Other|alias]] and [site](https://example.com)[^1] %%note%%\n\n[^1]: The note.\n");
  });
});

describe("what the export accounts for", () => {
  const schema = hmdocSchema();
  const base = richSchema();

  it("every node, mark and attribute the rich page has that Markdown pages lack is classified", () => {
    const missing: string[] = [];
    for (const [name, type] of Object.entries(schema.nodes)) {
      const known = base.nodes[name];
      // A new node is classified as a whole; an old one by the attributes it gained.
      if (!known) { if (!CLASSIFIED[`node:${name}`]) missing.push(`node:${name}`); continue; }
      for (const attr of Object.keys(attrsOf(type))) if (!(attr in attrsOf(known)) && !CLASSIFIED[`attr:${name}.${attr}`]) missing.push(`attr:${name}.${attr}`);
    }
    for (const [name, type] of Object.entries(schema.marks)) {
      const known = base.marks[name];
      if (!known) { if (!CLASSIFIED[`mark:${name}`]) missing.push(`mark:${name}`); continue; }
      for (const attr of Object.keys(attrsOf(type))) if (!(attr in attrsOf(known)) && !CLASSIFIED[`attr:${name}.${attr}`]) missing.push(`attr:${name}.${attr}`);
    }
    expect(missing).toEqual([]);
  });

  it("classifies the cell attributes Markdown cannot write, though Tiptap's own table has them too", () => {
    for (const type of ["tableCell", "tableHeader"]) {
      for (const attr of Object.keys(attrsOf(schema.nodes[type]))) expect(CLASSIFIED[`attr:${type}.${attr}`], `${type}.${attr}`).toBeTruthy();
    }
  });

  it("everything classified exists in the schema, and every report item is reachable", () => {
    for (const key of Object.keys(CLASSIFIED)) {
      const [kind, name] = key.split(":");
      if (kind === "node") expect(schema.nodes[name], key).toBeTruthy();
      if (kind === "mark") expect(schema.marks[name], key).toBeTruthy();
      if (kind === "attr") {
        const [type, attr] = name.split(".");
        expect(attr in attrsOf(schema.nodes[type] ?? schema.marks[type]), key).toBe(true);
      }
    }
    const used = new Set(Object.values(CLASSIFIED).filter((v) => v !== "internal"));
    expect([...used].sort()).toEqual(Object.keys(REPORT_LABELS).sort());
  });

  it("a page that uses everything reports every item it classifies", () => {
    const { doc: d, meta } = everything();
    const reported = new Set(exportMarkdown(d, meta).report.map((r) => r.key));
    for (const [key, value] of Object.entries(CLASSIFIED)) {
      if (value !== "internal") expect(reported.has(value), `${key} -> ${value}`).toBe(true);
    }
  });

  it("each construct reports on its own: take it out of the page and its item goes", () => {
    const { doc: d, meta } = everything();
    const json = () => JSON.parse(JSON.stringify(d.toJSON())) as { content: { type: string; content?: { marks?: { type: string }[] }[] }[] };
    const noToggle = json();
    noToggle.content = noToggle.content.filter((b) => b.type !== "toggle");
    const withoutToggle = counts(exportMarkdown(hmdocSchema().nodeFromJSON(noToggle), meta).report);
    expect(withoutToggle.toggles).toBeUndefined();
    expect(withoutToggle.columns).toBe(1);
    const noColour = json();
    for (const run of noColour.content[1].content ?? []) run.marks = run.marks?.filter((m) => m.type !== "textColor");
    const withoutColour = counts(exportMarkdown(hmdocSchema().nodeFromJSON(noColour), meta).report);
    expect(withoutColour.textColours).toBeUndefined();
    expect(withoutColour.toggles).toBe(1);
  });
});

describe("convert to a rich page", () => {
  const MD = "---\ntitle: Plan\n---\n\n# Plan\n\nSome *text* with a [[Link|alias]] and ==mark==.\n\n- one\n- [x] two\n\n> [!tip]- Fold\n> Body\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<div>html</div>\n\n```js\nlet a = 1;\n```\n";

  it("makes a file the editor holds, with no Markdown-only attributes and a table id", () => {
    const text = convertMarkdown(MD, "Plan");
    const r = inspect(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.meta).toEqual({ title: "Plan" });
    const names: string[] = [];
    r.doc.forEach((n) => names.push(n.type.name));
    expect(names).toEqual(["rawBlock", "heading", "paragraph", "bulletList", "callout", "table", "rawBlock", "codeBlock"]);
    // Source boxes stay source boxes.
    expect(r.doc.child(0).attrs).toEqual({ kind: "frontmatter", value: "---\ntitle: Plan\n---" });
    expect(r.doc.child(6).attrs).toEqual({ kind: "html", value: "<div>html</div>" });
    expect(r.doc.child(5).attrs.id).toMatch(/^t[a-z0-9]{5,}$/);
    expect(text).not.toContain("srcId");
    expect(text).not.toContain('"original"');
    expect(text).not.toContain("setext");
    expect(JSON.parse(text).content.content[1].attrs).toEqual({ level: 1 });
  });

  it("is a page whose export reads back as the page it came from", () => {
    const r = inspect(convertMarkdown(MD, "Plan"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = exportMarkdown(r.doc, r.envelope.meta);
    expect(out.report).toEqual([]);
    expect(out.text).toBe(MD);
  });

  it("gives each table its own id and an empty page one paragraph", () => {
    const d = markdownToRichDoc("| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |\n");
    const ids: string[] = [];
    d.descendants((n) => { if (n.type.name === "table") ids.push(n.attrs.id); return true; });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const empty = markdownToRichDoc("");
    expect(empty.childCount).toBe(1);
    expect(empty.child(0).type.name).toBe("paragraph");
  });
});
