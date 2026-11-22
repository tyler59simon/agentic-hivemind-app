import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/note-format.json";
import {
  actionItems, allowsActions, builtinDef, defaultTags, formatBody, outline, parts, rewriteWikilinks, sectionKey, sections,
  stripTitle, template, TEMPLATE_PROMPTS, wikilinks,
} from "./note";
import type { NoteTypeDef } from "./lm";

describe("parity with Living Memory's note_format", () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      expect(formatBody(c.raw)).toBe(c.body);
      expect(formatBody(c.body)).toBe(c.body);
      expect(actionItems(c.body).map((a) => [a.done, a.text])).toEqual(c.actions);
      expect(sections(c.body)).toEqual(c.sections);
      expect(parts(c.body).map((p) => [p.key, p.heading, p.text])).toEqual(c.parts);
    });
  }

  it("numbers ticked items too, 1-based, with their line", () => {
    const body = "S\n\n## Action items\n- [x] done\n- [ ] open";
    expect(actionItems(body)).toEqual([
      { index: 1, line: 3, done: true, text: "done" },
      { index: 2, line: 4, done: false, text: "open" },
    ]);
  });
});

describe("section keys", () => {
  it("match on letters only, with the legacy headings as aliases", () => {
    expect(sectionKey("Action items")).toBe("actions");
    expect(sectionKey("🟩 Action Items")).toBe("actions");
    expect(sectionKey("action  items!")).toBe("actions");
    expect(sectionKey("📌 Executive Summary")).toBe("summary");
    expect(sectionKey("Summary")).toBe("summary");
    expect(sectionKey("📝 Key Details")).toBe("details");
    expect(sectionKey("🗂️ Resource Links")).toBe("links");
    expect(sectionKey("Why")).toBeNull();
  });
});

describe("layout", () => {
  it("reads a legacy body and writes it in the current layout", () => {
    const legacy = "# 🎯 Cache\n\n## 📌 Executive Summary\nRebuildable.\n\n---\n\n## 📝 Key Details\n* a\n\n## 🟩 Action Items\n- [ ] x\n\n> ℹ️ **Important Note:** careful";
    expect(sections(legacy)).toEqual({ summary: "Rebuildable.", details: "* a", actions: "- [ ] x", important: "careful" });
    expect(formatBody(legacy)).toBe("Rebuildable.\n\n> **Important:** careful\n\n## Details\n* a\n\n## Action items\n- [ ] x");
  });

  it("takes the text before the first heading as the summary", () => {
    expect(sections("Headless summary.\n\n## Links\n- [[a]]")).toEqual({ summary: "Headless summary.", links: "- [[a]]" });
    expect(sections("Just text.")).toEqual({ summary: "Just text." });
  });

  it("gives a body that starts with a named section no summary", () => {
    expect(sections("## Why\nBecause.")).toEqual({});
    expect(formatBody("## Why\nBecause.")).toBe("## Why\nBecause.");
  });

  it("moves the callout after the summary and keeps typed and other sections in written order", () => {
    const body = "Chose A.\n\n## Why\nFast.\n\n## Details\n- d\n\n> **Important:** check B first\n\n## Alternatives considered\n- B";
    expect(parts(body).map((p) => p.key ?? p.heading)).toEqual(["summary", "important", "Why", "details", "Alternatives considered"]);
  });

  it("keeps a quote that only starts with the word Important", () => {
    expect(sections("S\n\n> Important things").important).toBeUndefined();
    expect(sections("S\n\n> Important: things").important).toBe("things");
  });

  it("strips a plain title heading only from note file text", () => {
    expect(stripTitle("# 🎯 Old\nBody")).toBe("Body");
    expect(stripTitle("# Title\nBody")).toBe("# Title\nBody");
    expect(stripTitle("# Title\nBody", true)).toBe("Body");
    expect(stripTitle("## Why\nBody", true)).toBe("## Why\nBody");
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
  it("templates follow LM's per-type Obsidian templates", () => {
    expect(template("decision")).toBe(`${TEMPLATE_PROMPTS.decision}\n\n> **Important:** \n\n## Why\n\n## Alternatives considered\n\n## Links\n- \n`);
    expect(template("plan")).toBe(`${TEMPLATE_PROMPTS.plan}\n\n> **Important:** \n\n## Details\n- \n\n## Links\n- \n\n## Action items\n- [ ] \n`);
    expect(template("knowledge")).toBe(`${TEMPLATE_PROMPTS.knowledge}\n\n> **Important:** \n\n## Links\n- \n`);
    expect(template("bug")).toContain("## Cause\n\n## Fix\n\n## How to check\n\n## Links\n- \n\n## Action items");
    expect(template("runbook")).toContain("## Roll back");
    expect(template("runbook")).not.toContain("If it fails");
    expect(template("decision")).not.toContain("Action items");
    // Only the prompt survives formatting: it is the summary, the empty sections drop out.
    expect(sections(template("research"))).toEqual({ summary: TEMPLATE_PROMPTS.research });
  });

  it("default tags mirror LM's inference and respect the taxonomy", () => {
    const tax = ["subject/project", "subject/user", "concern/decision", "concern/preference"];
    expect(defaultTags("decision", tax)).toEqual(["subject/project", "concern/decision"]);
    expect(defaultTags("preference", tax)).toEqual(["subject/user", "concern/preference"]);
    expect(defaultTags("plan", tax)).toEqual(["subject/project"]);
    expect(defaultTags("bug", tax)).toEqual(["subject/project"]); // concern/bug is not in this taxonomy
    expect(defaultTags("brief", [...tax, "concern/knowledge"])).toEqual(["subject/project", "concern/knowledge"]);
  });

  const incident: NoteTypeDef = {
    name: "incident", builtin: false, status: "active", description: "Outages and what we learned.", summary: "What broke, for whom and for how long.",
    sections: ["Timeline", "Impact"], actions: true, review_days: 60, concern: "concern/bug", subject: null,
  };

  it("a custom type's definition drives its template", () => {
    expect(template("incident", incident)).toBe(
      `${incident.summary}

> **Important:** 

## Timeline

## Impact

## Links
- 

## Action items
- [ ] 
`);
    // No sections of its own: Details instead, and no Action items unless the type has them.
    expect(template("incident", { ...incident, sections: [], actions: false, summary: "" })).toBe(`

> **Important:** 

## Details
- 

## Links
- 
`);
    // Without a definition, an unknown type gets the plain layout.
    expect(template("incident")).toBe(`

> **Important:** 

## Details
- 

## Links
- 
`);
    expect(template("brief")).toContain("What the project is and where it stands.");
  });

  it("a custom type's definition drives its default tags and Action items", () => {
    const tax = ["subject/project", "subject/team", "concern/bug"];
    expect(defaultTags("incident", tax, incident)).toEqual(["subject/project", "concern/bug"]);
    expect(defaultTags("incident", tax, { ...incident, subject: "subject/team", concern: null })).toEqual(["subject/team"]);
    expect(allowsActions("incident", incident)).toBe(true);
    expect(allowsActions("incident")).toBe(false);
    expect(allowsActions("plan")).toBe(true);
    expect(allowsActions("decision")).toBe(false);
  });

  it("a custom type named after an Object property reads no built-in table", () => {
    expect(builtinDef("constructor")).toMatchObject({ summary: "", sections: [], actions: false, concern: null, subject: null });
    expect(template("constructor")).toBe(template("incident"));
    expect(defaultTags("constructor", ["subject/project"])).toEqual(["subject/project"]);
    expect(allowsActions("toString")).toBe(false);
  });
});

describe("action items", () => {
  const body = [
    "Summary.", "", "> **Important:** Mind the replay window.", "",
    "## Details", "- Detail", "", "## Action items", "- [ ] Define a durable event key", "- [x] Add the dedupe store", "",
  ].join("\n");

  it("lists the section's task lines and nothing else", () => {
    expect(actionItems(body).map((a) => [a.index, a.done, a.text])).toEqual([[1, false, "Define a durable event key"], [2, true, "Add the dedupe store"]]);
  });
});
