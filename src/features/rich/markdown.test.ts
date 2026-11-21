// NS-3B: Rich mode reads Obsidian syntax as Live does (NS-3A's `richSyntax` is the reference), and writes edited
// blocks plainly where that reads back the same, keeping the page's own choices.
import { GFM, parser as lezer } from "@lezer/markdown";
import type { Nodes } from "mdast";
import type { Construct, Event, Token, TokenizeContext } from "micromark-util-types";
import { describe, expect, it } from "vitest";
import { richSyntax } from "../editor/rich/syntax";
import { loadPage, markdownNodes } from "./fromMarkdown";
import { DEFAULT_STYLE, parse, stringify } from "./markdown";
import { obsidian } from "./micromark/obsidian";
import { serialize } from "./preserve";
import { richSchema } from "./schema";
import { blockToMdast, readsAs, writeBlock } from "./toMarkdown";
import { wikiParts } from "./views";

const live = lezer.configure([GFM, richSyntax]);
const LIVE: Record<string, string> = { InlineMath: "inlineMath", BlockMath: "math", Highlight: "highlight", Comment: "comment" };

/** The Obsidian constructs Live finds, as `type:from-to`. */
function liveFinds(text: string): string[] {
  const out: string[] = [];
  live.parse(text).iterate({ enter: (n) => { if (LIVE[n.name]) out.push(`${LIVE[n.name]}:${n.from}-${n.to}`); } });
  return out.sort();
}

/** The same constructs Rich parses. */
function richFinds(text: string): string[] {
  const out: string[] = [];
  const visit = (n: Nodes) => {
    if (Object.values(LIVE).includes(n.type)) out.push(`${n.type}:${n.position!.start.offset}-${n.position!.end.offset}`);
    if ("children" in n) for (const c of n.children as Nodes[]) visit(c);
  };
  visit(parse(text));
  return out.sort();
}

const CASES = [
  "Prices like $5 and $6 stay text.",
  "Math $x^2$ and $$\\sum x$$ inline.",
  "Not math: $ x$, $x $, \\$x$ and $x$5.",
  "`$code$` is code, $a$b$ is one.",
  "A ==highlight== and ===three=== and == spaced ==.",
  "%%a%% b %%c%% and %% spaced %%.",
  "==bold **inside**== and %%comment with *stars*%%",
  "$$\nE = mc^2\n$$",
  "$$ a + b $$",
  "$$\nunclosed math to the end\nof the page",
  "Text\n$$\ninterrupts\n$$",
  "- item\n\n  $$\n  x\n  $$\n- next",
  "> $$\n> x\n> $$",
  // Codex review of 2392f6b, R1-P1: a comment over two lines of one paragraph.
  "Before %%first\nsecond%% after.",
];

describe("Rich reads Obsidian syntax as Live does", () => {
  it.each(CASES)("%j", (text) => {
    expect(richFinds(text)).toEqual(liveFinds(text));
  });

  it("reads [[links]] and ![[embeds]] as single nodes, not as brackets", () => {
    const p = parse("See [[Page#Part|shown]] and ![[pic.png|300]], not [[]] or [[a\nb]].").children[0] as { children: Nodes[] };
    expect(p.children.filter((c) => c.type !== "text").map((c) => `${c.type}:${(c as { value: string }).value}`)).toEqual(["wikiLink:Page#Part|shown", "embed:pic.png|300"]);
  });
});

describe("writing an edited block", () => {
  const schema = richSchema();
  /** The page's first block written again (as an edited block is). */
  const rewrite = (page: string, index = 0) => {
    const { doc, original } = loadPage(schema, page);
    return writeBlock(doc.child(index), original.style, original.definitions);
  };

  it("keeps brackets, asterisks and dollars in prose unescaped when that reads back the same", () => {
    expect(rewrite("See [this] and a * b and $5 here.\n")).toBe("See [this] and a * b and $5 here.");
  });

  it("escapes what would otherwise change meaning", () => {
    expect(rewrite("\\*not emphasis\\* and \\[not\\](link)\n")).toBe("\\*not emphasis\\* and \\[not]\\(link)");
  });

  it("reads references against the page's definitions", () => {
    expect(rewrite("A [ref][r] and a note[^n].\n\n[r]: https://x\n\n[^n]: Note.\n")).toBe("A [ref][r] and a note[^n].");
  });

  it("keeps a list's marker, a heading's underline, a fence's character and a rule's spelling", () => {
    expect(rewrite("+ a\n+ b\n")).toBe("+ a\n+ b");
    expect(rewrite("1) a\n2) b\n")).toBe("1) a\n2) b");
    expect(rewrite("Title\n=====\n")).toBe("Title\n=====");
    expect(rewrite("~~~js\nx\n~~~\n")).toBe("~~~js\nx\n~~~");
    expect(rewrite("- - -\n")).toBe("- - -");
  });

  it("writes new blocks in the page's style", () => {
    const page = "* a\n\n_b_ and __c__\n";
    const { doc, original } = loadPage(schema, page);
    expect(original.style).toMatchObject({ bullet: "*", emphasis: "_", strong: "_" });
    const list = doc.child(0);
    const fresh = list.type.create({ ...list.attrs, srcId: null, marker: null }, list.content);
    expect(writeBlock(fresh, original.style, [])).toBe("* a");
  });

  it("does not pad table columns past 60 characters", () => {
    const long = "x".repeat(70);
    const out = rewrite(`| a | b |\n|---|---|\n| ${long} | 1 |\n| 2 | 3 |\n`);
    expect(out.split("\n")[3]).toBe("| 2 | 3 |");
  });

  it("puts a new list next to a list of the same kind with the other marker, so they stay two lists", () => {
    const page = "- a\n- b\n";
    const { doc, original } = loadPage(schema, page);
    const copy = doc.child(0).type.create({ ...doc.child(0).attrs, srcId: null }, doc.child(0).content);
    const out = serialize(doc.type.create(null, [doc.child(0), copy]), original);
    expect(parse(out).children).toHaveLength(2);
    expect(out).toBe("- a\n- b\n\n* a\n* b\n");
  });
});

describe("Codex review of 2392f6b", () => {
  const schema = richSchema();
  const page = (text: string) => loadPage(schema, text);
  const blocks = (text: string) => parse(text).children.map((c) => c.type);

  it("opens a page with a comment over two lines (R1-P1)", () => {
    const { doc } = page("Before %%first\nsecond%% after.\n");
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("paragraph");
  });

  it("matches runs of == that never pair in linear work (R1-15)", () => {
    // The resolver's reads of the event list are counted, not timed, so a busy machine cannot decide it (Codex review
    // of b0afec0, R2-9). The scan back over earlier runs read about n * n / 2 events.
    const highlight = (obsidian().text as Record<number, Construct>)[61];
    const n = 4000;
    const events: Event[] = [];
    const context = { parser: { constructs: { insideSpan: { null: undefined } } } } as unknown as TokenizeContext;
    for (let i = 0; i < n; i++) {
      const token = { type: "obsidianHighlightTemporary", _open: false, _close: true, start: {}, end: {} } as unknown as Token;
      events.push(["enter", token, context], ["exit", token, context]);
    }
    let reads = 0;
    const counted = new Proxy(events, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
    highlight.resolveAll!(counted, context);
    expect(reads).toBeLessThan(10 * events.length);
  });

  it("parts two blocks with a blank line once one changes type (R1-2)", () => {
    const { doc, original } = page("One\n## Two\n");
    const heading = doc.child(1);
    const para = schema.nodes.paragraph.create({ srcId: heading.attrs.srcId }, heading.content);
    const out = serialize(doc.type.create(null, [doc.child(0), para]), original);
    expect(out).toBe("One\n\nTwo\n");
    expect(blocks(out)).toEqual(["paragraph", "paragraph"]);
  });

  it("keeps two lists apart when the block between them is deleted (R1-3)", () => {
    const { doc, original } = page("- a\n\nmid\n\n- b\n");
    const out = serialize(doc.type.create(null, [doc.child(0), doc.child(2)]), original);
    expect(blocks(out)).toEqual(["list", "list"]);
    expect(out).toBe("- a\n\n* b\n");
  });

  it.each([["fence", "Para\n\n```\ncode"], ["display math", "Para\n\n$$\nx"]])("closes an unclosed %s that moves above another block (R1-4)", (_, text) => {
    const { doc, original } = page(text);
    const out = serialize(doc.type.create(null, [doc.child(1), doc.child(0)]), original);
    expect(blocks(out)).toEqual([text.includes("$$") ? "math" : "code", "paragraph"]);
    expect(out.trimEnd().endsWith("Para")).toBe(true);
  });

  it("moves an indented fence with its indentation, so its code stays the same (R1-5)", () => {
    const { doc, original } = page("Para\n\n  ```py\n  print(1)\n  ```\n");
    const out = serialize(doc.type.create(null, [doc.child(1), doc.child(0)]), original);
    const code = parse(out).children[0] as { type: string; value: string };
    expect(code).toMatchObject({ type: "code", value: "print(1)" });
  });

  it("escapes pipes of links, embeds and math in a table cell (R1-6)", () => {
    const cell = (children: unknown[]) => ({ type: "tableCell", children });
    const head = { type: "tableRow", children: [cell([{ type: "text", value: "a" }]), cell([{ type: "text", value: "b" }]), cell([{ type: "text", value: "c" }])] };
    const row = { type: "tableRow", children: [cell([{ type: "wikiLink", value: "Page|alias" }]), cell([{ type: "embed", value: "pic.png|60" }]), cell([{ type: "inlineMath", value: "|x|", dollars: 1 }])] };
    const table = { type: "table", align: [null, null, null], children: [head, row] };
    for (const relaxed of [true, false]) {
      const out = stringify([table as never], DEFAULT_STYLE, relaxed);
      const rows = (parse(out).children[0] as unknown as { children: { children: unknown[] }[] }).children;
      expect(rows[1].children).toHaveLength(3);
      expect(out).toContain("[[Page\\|alias]]");
    }
  });

  it("shows the alias of a link whose pipe is escaped in a table (R1-6)", () => {
    expect(wikiParts("Page\\|alias")).toEqual({ target: "Page", shown: "alias" });
  });
});

describe("Codex review of b0afec0", () => {
  const schema = richSchema();
  const page = (text: string) => loadPage(schema, text);
  const blocks = (text: string) => parse(text).children.map((c) => c.type);

  it("gives a new list the other marker rather than an original list, so the next list stays apart (R2-P1)", () => {
    const { doc, original } = page("1. a\n2. b\n\n1) c\n");
    const fresh = doc.child(0).type.create({ ...doc.child(0).attrs, srcId: null, marker: "." }, doc.child(0).content);
    const out = serialize(doc.type.create(null, [fresh, doc.child(0), doc.child(1)]), original);
    expect(blocks(out)).toEqual(["list", "list", "list"]);
    expect(out.endsWith("1. a\n2. b\n\n1) c\n")).toBe(true);
  });

  it("opens a comment holding thousands of code spans (R2-2)", () => {
    const { doc } = page(`%%${"`a` ".repeat(21000)}%%\n`);
    expect(doc.child(0).type.name).toBe("paragraph");
  });

  it("keeps an indented paragraph moved below a list shown as a source box out of the list (R2-3)", () => {
    const { doc, original } = page("  Para\n\n- [x\n  y][r]\n\n[r]: https://x\n");
    expect(doc.child(1).type.name).toBe("rawBlock");
    const out = serialize(doc.type.create(null, [doc.child(1), doc.child(0), doc.child(2)]), original);
    expect(blocks(out)).toEqual(["list", "paragraph", "definition"]);
  });

  it("reads back the pipes of math and embeds in a table cell as written (R2-4)", () => {
    const { doc } = page("| a | b | c |\n|---|---|---|\n| $\\|x\\|$ | ![[pic.png\\|60]] | [[Page\\|alias]] |\n");
    const values: string[] = [];
    doc.descendants((n) => { if (n.attrs.value !== undefined && n.isAtom) values.push(n.attrs.value); return true; });
    expect(values).toEqual(["|x|", "pic.png|60", "Page|alias"]);
    const out = writeBlock(doc.child(0), DEFAULT_STYLE, []);
    expect(out).toContain("$\\|x\\|$");
    const again = page(`${out}\n`).doc;
    const back: string[] = [];
    again.descendants((n) => { if (n.attrs.value !== undefined && n.isAtom) back.push(n.attrs.value); return true; });
    expect(back).toEqual(values);
  });
});

describe("Codex review of ad6c5c5", () => {
  const schema = richSchema();
  const cell = (children: unknown[]) => ({ type: "tableCell", children });
  const table = (nodes: unknown[]) => ({
    type: "table", align: [null, null, null],
    children: [
      { type: "tableRow", children: [cell([{ type: "text", value: "a" }]), cell([{ type: "text", value: "b" }]), cell([{ type: "text", value: "c" }])] },
      { type: "tableRow", children: [cell([nodes[0]]), cell([nodes[1]]), cell([{ type: "text", value: "end" }])] },
    ],
  });
  const row = (text: string) => (parse(text).children[0] as unknown as { children: { children: { children: { type: string; value?: string }[] }[] }[] }).children[1].children;

  it("keeps TeX backslashes before pipes in a table cell (R3-1)", () => {
    for (const value of ["\\|x\\|", "a\\\\|b", "|x|", "plain \\ back"]) {
      for (const relaxed of [true, false]) {
        const out = stringify([table([{ type: "inlineMath", value, dollars: 1 }, { type: "wikiLink", value: `P|${value}` }]) as never], DEFAULT_STYLE, relaxed);
        const cells = row(out);
        expect(cells, out).toHaveLength(3);
        expect(cells[0].children[0]).toMatchObject({ type: "inlineMath", value });
        expect(cells[1].children[0]).toMatchObject({ type: "wikiLink", value: `P|${value}` });
      }
    }
  });

  it("escapes the pipes of a comment or inline source in a table cell once (R3-2)", () => {
    for (const relaxed of [true, false]) {
      const out = stringify([table([{ type: "comment", value: "%%a|b%%" }, { type: "raw", value: "<b>x\\|y</b>" }]) as never], DEFAULT_STYLE, relaxed);
      expect(row(out), out).toHaveLength(3);
      expect(out).toContain("%%a\\|b%%");
      expect(out).toContain("<b>x\\|y</b>");
    }
  });

  it("keeps a new list apart from the next one when the writer must keep its marker (R3-3)", () => {
    const { doc, original } = loadPage(schema, "* a\n");
    const [fresh] = markdownNodes(schema, "* ---\n");
    expect(fresh.type.name).toBe("bulletList");
    const out = serialize(doc.type.create(null, [fresh.type.create({ ...fresh.attrs, marker: null }, fresh.content), doc.child(0)]), original);
    expect(parse(out).children.map((c) => c.type)).toEqual(["list", "list"]);
  });
});

describe("long lists, written item by item (UI pass of NS-3B)", () => {
  const schema = richSchema();
  const items = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("");

  it("writes an edited item alone and the list reads back the same", () => {
    const text = items(40, (i) => `- item ${i} with *some* text\n`);
    const { doc } = loadPage(schema, text);
    const list = doc.child(0);
    const item = list.child(7);
    const para = item.child(0);
    const edited = item.copy(item.content.replaceChild(0, para.copy(para.content.addToEnd(schema.text(" more")))));
    const next = list.type.create(list.attrs, list.content.replaceChild(7, edited));
    const out = writeBlock(next, DEFAULT_STYLE, []);
    expect(out.split("\n")[7]).toBe("- item 7 with *some* text more");
    expect(out.split("\n").filter((_l, i) => i !== 7)).toEqual(text.trimEnd().split("\n").filter((_l, i) => i !== 7));
    expect(readsAs(out, blockToMdast(next)!, [])).toBe(true);
  });

  it("numbers a loose ordered list from its start and keeps it loose", () => {
    const { doc } = loadPage(schema, items(40, (i) => `${i + 5}) item ${i}\n\n`));
    const list = doc.child(0);
    const out = writeBlock(list, loadPage(schema, "1) a\n").original.style, []);
    expect(out.startsWith("5) item 0\n\n6) item 1\n\n")).toBe(true);
    expect(readsAs(out, blockToMdast(list)!, [])).toBe(true);
  });

  it("writes the whole list at once when an item would take another marker", () => {
    const { doc } = loadPage(schema, `* ---\n${items(40, (i) => `* item ${i}\n`)}`);
    const list = doc.child(0);
    const dashed = list.type.create({ ...list.attrs, marker: "-" }, list.content);
    const out = writeBlock(dashed, DEFAULT_STYLE, []);
    expect(parse(out).children).toHaveLength(1);
    expect(readsAs(out, blockToMdast(dashed)!, [])).toBe(true);
  });
});
