import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/note-format.json";
import { actionItems, defaultTags, outline, rewriteWikilinks, sectionKey, sections, template, wikilinks } from "./note";

describe("parity with Living Memory's note_format", () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      expect(actionItems(c.body).map((a) => [a.done, a.text])).toEqual(c.actions);
      expect(sections(c.body)).toEqual(c.sections);
    });
  }

  it("numbers ticked items too, 1-based, with their line", () => {
    const body = "## 📌 Executive Summary\nS\n\n## 🟩 Action Items\n- [x] done\n- [ ] open";
    expect(actionItems(body)).toEqual([
      { index: 1, line: 4, done: true, text: "done" },
      { index: 2, line: 5, done: false, text: "open" },
    ]);
  });
});

describe("section keys", () => {
  it("match on letters only", () => {
    expect(sectionKey("🟩 Action Items")).toBe("actions");
    expect(sectionKey("action  items!")).toBe("actions");
    expect(sectionKey("Summary")).toBeNull();
  });
});

describe("wikilinks", () => {
  it("parse targets like LM (text before | or #)", () => {
    const found = wikilinks("See [[Cache|the cache]] and [[ Plan #why ]] or [[x#h|y]].");
    expect(found.map((l) => l.target)).toEqual(["Cache", "Plan", "x"]);
    expect(found[0].alias).toBe("the cache");
    expect(found[2]).toMatchObject({ heading: "h", alias: "y" });
  });

  it("rewrite on rename keeping alias and heading, case-insensitively", () => {
    const body = "[[Old Title]] [[old title|alias]] [[OLD TITLE#h]] [[Old Titles]] [[ Old Title ]]";
    expect(rewriteWikilinks(body, "Old Title", "New (v2)"))
      .toBe("[[New (v2)]] [[New (v2)|alias]] [[New (v2)#h]] [[Old Titles]] [[New (v2)]]");
  });
});

describe("outline", () => {
  it("lists headings outside fences", () => {
    expect(outline("## A\n```\n## not\n```\n### B #").map((h) => [h.level, h.text, h.line])).toEqual([[2, "A", 0], [3, "B", 4]]);
  });
});

describe("new notes", () => {
  it("templates include Action Items only for plan, bug and risk", () => {
    expect(template("plan")).toContain("Action Items");
    expect(template("decision")).not.toContain("Action Items");
    expect(template("decision")).toMatch(/^## 📌 Executive Summary/);
  });

  it("default tags mirror LM's inference and respect the taxonomy", () => {
    const tax = ["subject/project", "subject/user", "concern/decision", "concern/preference"];
    expect(defaultTags("decision", tax)).toEqual(["subject/project", "concern/decision"]);
    expect(defaultTags("preference", tax)).toEqual(["subject/user", "concern/preference"]);
    expect(defaultTags("plan", tax)).toEqual(["subject/project"]);
    expect(defaultTags("bug", tax)).toEqual(["subject/project"]); // concern/bug is not in this taxonomy
  });
});
