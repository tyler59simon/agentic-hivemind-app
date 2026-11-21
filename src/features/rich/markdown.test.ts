// NS-3B: Rich mode reads Obsidian syntax as Live does (NS-3A's `richSyntax` is the reference), and writes edited
// blocks plainly where that reads back the same, keeping the page's own choices.
import { GFM, parser as lezer } from "@lezer/markdown";
import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import { richSyntax } from "../editor/rich/syntax";
import { loadPage } from "./fromMarkdown";
import { parse } from "./markdown";
import { serialize } from "./preserve";
import { richSchema } from "./schema";
import { writeBlock } from "./toMarkdown";

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
