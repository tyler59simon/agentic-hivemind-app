import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/note-format.json";
import {
  actionItems, addEvidence, defaultTags, evidenceItems, formatBody, outline, parts, rewriteWikilinks, sectionKey, sections,
  setEvidence, stepParts, stripTitle, template, TEMPLATE_PROMPTS, wikilinks,
} from "./note";

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
  });
});

describe("acceptance evidence", () => {
  const callout = "> **Important:** Mind the replay window.";
  const body = [
    "Summary.", "", callout, "", "## Acceptance evidence", "- [ ] Replay produces no duplicate alert", "- [x] Suppression survives a restart", "",
    "## Details", "- Detail", "", "## Action items", "- [ ] Define a durable event key", "- [x] Add the dedupe store", "",
  ].join("\n");

  it("lists the section's task lines and nothing else", () => {
    expect(evidenceItems(body).map((e) => [e.index, e.done, e.text])).toEqual([
      [1, false, "Replay produces no duplicate alert"], [2, true, "Suppression survives a restart"],
    ]);
    expect(actionItems(body).map((a) => a.text)).toEqual(["Define a durable event key", "Add the dedupe store"]);
  });

  it("matches the heading on its letters", () => {
    expect(evidenceItems(body.replace("## Acceptance evidence", "## ✅ ACCEPTANCE EVIDENCE"))).toHaveLength(2);
    expect(evidenceItems(body.replace("## Acceptance evidence", "## Evidence"))).toEqual([]);
  });

  it("ignores a look-alike heading inside a code fence", () => {
    expect(evidenceItems("Summary.\n\n```\n## Acceptance evidence\n- [ ] fake\n```\n")).toEqual([]);
  });

  it("ticks one line in place", () => {
    const ticked = setEvidence(body, 1, true).split("\n");
    const before = body.split("\n");
    expect(ticked.length).toBe(before.length);
    expect(ticked.filter((l, i) => l !== before[i])).toEqual(["- [x] Replay produces no duplicate alert"]);
    expect(setEvidence(setEvidence(body, 1, true), 1, false)).toBe(body.replace(/\r\n/g, "\n"));
    expect(() => setEvidence(body, 3, true)).toThrow(RangeError);
  });

  it("adds to an existing section", () => {
    const next = addEvidence(body, " Third\nitem ");
    const items = evidenceItems(next);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ done: false, text: "Third item" });
    expect(next.indexOf("## Details")).toBeGreaterThan(next.indexOf("- [ ] Third item"));
  });

  it("creates the section where LM's set_section would: before Details, Links or Action items, else at the end", () => {
    const bare = ["Summary.", "", callout, "", "## Why", "Because.", "", "## Links", "- [[a]]", "", "## Action items", "- [ ] One"].join("\n");
    const next = addEvidence(bare, "X");
    const lines = next.split("\n");
    expect(lines.indexOf("## Acceptance evidence")).toBeGreaterThan(lines.indexOf("Because."));
    expect(lines.indexOf("## Acceptance evidence")).toBeLessThan(lines.indexOf("## Links"));
    expect(parts(next).map((p) => p.key ?? p.heading)).toEqual(["summary", "important", "Why", "Acceptance evidence", "links", "actions"]);
    // A legacy body with the callout last: the section still goes before Action items.
    const legacy = ["## 📌 Executive Summary", "S", "", "## 🟩 Action Items", "- [ ] One", "", "> ℹ️ **Important Note:** careful"].join("\n");
    const old = addEvidence(legacy, "X").split("\n");
    expect(old.indexOf("## Acceptance evidence")).toBeLessThan(old.indexOf("## 🟩 Action Items"));
    expect(addEvidence("Summary.\n", "X").endsWith("## Acceptance evidence\n- [ ] X")).toBe(true);
  });

  it("splits a step at the first spaced em dash and unwraps links", () => {
    expect(stepParts("Define a durable event key — Establish the event ID.")).toEqual({ title: "Define a durable event key", detail: "Establish the event ID." });
    expect(stepParts("Dedupe — decided in [[Use event ID as the idempotency key]]").detail).toBe("decided in Use event ID as the idempotency key");
    expect(stepParts("Ship [[Plan|the plan]]")).toEqual({ title: "Ship the plan", detail: "" });
  });
});
