// NS-7B: the frontmatter edit changes only what it is about. Every case compares whole texts, byte for byte.
import { describe, expect, it } from "vitest";
import { frontBlock, fromText, kindOf, readProps, removeProp, setProp } from "./frontmatter";

const PAGE = [
  "---",
  "# top comment",
  "title: \"Plan: Q4\"   # why",
  "status:   active",
  "tags: [a, 'b']",
  "owners:",
  "  - ana",
  "  - \"bo\"   # note",
  "empty:",
  "nested:",
  "  inner: x",
  "count: 3",
  "when: 2026-12-01",
  "---",
  "# Body",
  "text",
].join("\n");

describe("reading the properties", () => {
  it("finds the block, its kinds and the values the panel can edit", () => {
    const read = readProps(PAGE);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.props.map((p) => [p.key, p.kind, p.value, p.editable])).toEqual([
      ["title", "text", "Plan: Q4", true],
      ["status", "text", "active", true],
      ["tags", "list", ["a", "b"], true],
      ["owners", "list", ["ana", "bo"], true],
      ["empty", "text", "", true],
      ["nested", "text", "inner: x", false],
      ["count", "number", 3, true],
      ["when", "date", "2026-12-01", true],
    ]);
  });

  it("says so for a page with no block, a block that is not YAML, and one that is not a map", () => {
    expect(readProps("# Just a page\n").state).toBe("none");
    expect(readProps("---\nno closing line\n")).toEqual({ state: "none" });
    expect(readProps("---\na: [1, 2\n---\n")).toMatchObject({ state: "bad" });
    expect(readProps("---\na: 1\na: 2\n---\n")).toMatchObject({ state: "bad", reason: expect.stringContaining("not valid YAML") });
    expect(readProps("---\n- a\n- b\n---\n")).toMatchObject({ state: "bad" });
    expect(readProps("---\n{a: 1}\n---\n")).toMatchObject({ state: "bad", reason: expect.stringContaining("braces") });
    expect(readProps("---\n---\nbody")).toEqual({ state: "ok", props: [] });
  });

  it("gives each value a kind", () => {
    expect([true, 3, "2026-12-01", "[[Plan]]", "plain", ["a"]].map((v) => kindOf(v))).toEqual(["checkbox", "number", "date", "link", "text", "list"]);
    expect([fromText("3"), fromText("-2.5"), fromText("true"), fromText("007"), fromText("1e3"), fromText("done")]).toEqual([3, -2.5, true, "007", "1e3", "done"]);
  });

  it("locates the block after a byte order mark and for either line ending", () => {
    expect(frontBlock("﻿---\r\na: 1\r\n---\r\n")).toEqual({ from: 6, close: 12, eol: "\r\n" });
    expect(frontBlock("---  \na: 1\n...\nbody")).toEqual({ from: 6, close: 11, eol: "\n" });
    expect(frontBlock("text\n---\na: 1\n---\n")).toBeNull();
  });
});

describe("setting a property leaves every other byte alone", () => {
  /** The text with the one thing that should differ replaced: every edit below is `PAGE` with one line or value changed. */
  const edited = (from: string, to: string) => PAGE.replace(from, to);

  it("replaces a plain value in place and keeps its spacing and the comment after it", () => {
    expect(setProp(PAGE, "status", "done")).toBe(edited("status:   active", "status:   done"));
  });

  it("keeps the quote style of the value it replaces, and a comment after it", () => {
    expect(setProp(PAGE, "title", "New: title")).toBe(edited('"Plan: Q4"   # why', '"New: title"   # why'));
    expect(setProp("---\na: 'one'\nb: \"two\"\n---\n", "a", "it's")).toBe("---\na: 'it''s'\nb: \"two\"\n---\n");
    expect(setProp("---\na: 'one'\nb: \"two\"\n---\n", "b", "three")).toBe("---\na: 'one'\nb: \"three\"\n---\n");
    // A value that needs quotes gets them whatever the old style was.
    expect(setProp(PAGE, "status", "a: b")).toBe(edited("status:   active", 'status:   "a: b"'));
    expect(setProp(PAGE, "status", "123")).toBe(edited("status:   active", 'status:   "123"'));
  });

  it("writes numbers, booleans and dates as what they are", () => {
    expect(setProp(PAGE, "count", 4)).toBe(edited("count: 3", "count: 4"));
    expect(setProp(PAGE, "count", true)).toBe(edited("count: 3", "count: true"));
    expect(setProp(PAGE, "when", "2027-01-02")).toBe(edited("when: 2026-12-01", "when: 2027-01-02"));
    expect(setProp(PAGE, "status", "[[Plan]]")).toBe(edited("status:   active", 'status:   "[[Plan]]"'));
  });

  it("replaces a flow list as a flow list and a block list as a block list, keeping its indent", () => {
    expect(setProp(PAGE, "tags", ["x", "y z", "a, b"])).toBe(edited("tags: [a, 'b']", 'tags: [x, y z, "a, b"]'));
    expect(setProp(PAGE, "owners", ["cy", "dee", "eve"])).toBe(edited('  - ana\n  - "bo"   # note', "  - cy\n  - dee\n  - eve"));
    expect(setProp(PAGE, "owners", [])).toBe(edited("owners:\n  - ana\n  - \"bo\"   # note", "owners: []"));
    expect(setProp(PAGE, "owners", "solo")).toBe(edited("owners:\n  - ana\n  - \"bo\"   # note", "owners: solo"));
    expect(setProp(PAGE, "status", ["a", "b"])).toBe(edited("status:   active", "status:   [a, b]"));
  });

  it("fills a key that had no value, and replaces a nested map", () => {
    expect(setProp(PAGE, "empty", "now")).toBe(edited("empty:\n", "empty: now\n"));
    expect(setProp(PAGE, "nested", "flat")).toBe(edited("nested:\n  inner: x", "nested: flat"));
    expect(setProp("---\nempty: # keep this\n---\n", "empty", "v")).toBe("---\nempty: v # keep this\n---\n");
  });

  it("adds a new key as the last line of the block, with the comments and order untouched", () => {
    expect(setProp(PAGE, "due", "2026-12-24")).toBe(edited("when: 2026-12-01\n---", "when: 2026-12-01\ndue: 2026-12-24\n---"));
    expect(setProp(PAGE, "weird key: x", "v")).toBe(edited("when: 2026-12-01\n---", 'when: 2026-12-01\n"weird key: x": v\n---'));
    expect(setProp("---\n---\nbody", "a", 1)).toBe("---\na: 1\n---\nbody");
  });

  it("makes a block for a page without one, in the page's line ending and after a byte order mark", () => {
    expect(setProp("# Page\ntext\n", "status", "new")).toBe("---\nstatus: new\n---\n# Page\ntext\n");
    expect(setProp("# Page\r\ntext\r\n", "tags", ["a"])).toBe("---\r\ntags: [a]\r\n---\r\n# Page\r\ntext\r\n");
    expect(setProp("﻿# Page", "a", true)).toBe("﻿---\na: true\n---\n# Page");
  });

  it("keeps Windows line endings in every kept byte and in the lines it adds", () => {
    const crlf = PAGE.replace(/\n/g, "\r\n");
    expect(setProp(crlf, "status", "done")).toBe(crlf.replace("status:   active", "status:   done"));
    expect(setProp(crlf, "owners", ["cy", "dee"])).toBe(crlf.replace('  - ana\r\n  - "bo"   # note', "  - cy\r\n  - dee"));
    expect(setProp(crlf, "due", "x")).toBe(crlf.replace("when: 2026-12-01\r\n---", "when: 2026-12-01\r\ndue: x\r\n---"));
    expect(removeProp(crlf, "count")).toBe(crlf.replace("count: 3\r\n", ""));
  });

  it("refuses to change properties it cannot read, and changes nothing", () => {
    for (const bad of ["---\na: [1\n---\nbody", "---\na: 1\na: 2\n---\n", "---\n- a\n---\n", "---\n{a: 1}\n---\n"]) {
      expect(() => setProp(bad, "b", "x")).toThrow();
      expect(() => removeProp(bad, "a")).toThrow();
    }
  });

  it("a value with a line break stays on one line", () => {
    expect(setProp(PAGE, "status", "a\nb")).toBe(edited("status:   active", "status:   a b"));
  });
});

describe("removing a property", () => {
  it("removes only that key's lines: a scalar with its comment, a block list, a nested map", () => {
    const without = (lines: string[]) => lines.reduce((t, l) => t.replace(l, ""), PAGE);
    expect(removeProp(PAGE, "title")).toBe(without(['title: "Plan: Q4"   # why\n']));
    expect(removeProp(PAGE, "owners")).toBe(without(["owners:\n  - ana\n  - \"bo\"   # note\n"]));
    expect(removeProp(PAGE, "nested")).toBe(without(["nested:\n  inner: x\n"]));
    expect(removeProp(PAGE, "empty")).toBe(without(["empty:\n"]));
    expect(removeProp(PAGE, "when")).toBe(without(["when: 2026-12-01\n"]));
  });

  it("changes nothing for a key the page lacks or a page with no block", () => {
    expect(removeProp(PAGE, "nope")).toBe(PAGE);
    expect(removeProp("# Page", "a")).toBe("# Page");
  });
});
