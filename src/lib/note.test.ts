import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/note-format.json";
import { actionItems, addEvidence, defaultTags, evidenceItems, outline, rewriteWikilinks, sectionKey, sections, setEvidence, stepParts, template, wikilinks } from "./note";

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

describe("acceptance evidence", () => {
  const callout = "> ℹ️ **Important Note:** Mind the replay window.";
  const body = [
    "Executive summary.", "", "---", "", "## Key Details", "- Detail", "", "## Action Items",
    "- [ ] Define a durable event key", "- [x] Add the dedupe store", "",
    "## Acceptance evidence", "- [ ] Replay produces no duplicate alert", "- [x] Suppression survives a restart", "", callout, "",
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
    expect(next.indexOf(callout)).toBeGreaterThan(next.indexOf("- [ ] Third item"));
  });

  it("creates the section before the callout, or at the end", () => {
    const bare = ["Summary.", "", "## Action Items", "- [ ] One", "", callout].join("\n");
    const lines = addEvidence(bare, "X").split("\n");
    expect(lines.indexOf("## Acceptance evidence")).toBeGreaterThan(-1);
    expect(lines.indexOf("## Acceptance evidence")).toBeLessThan(lines.indexOf(callout));
    expect(addEvidence("Summary.\n", "X").endsWith("## Acceptance evidence\n- [ ] X")).toBe(true);
  });

  it("splits a step at the first spaced em dash and unwraps links", () => {
    expect(stepParts("Define a durable event key — Establish the event ID.")).toEqual({ title: "Define a durable event key", detail: "Establish the event ID." });
    expect(stepParts("Dedupe — decided in [[Use event ID as the idempotency key]]").detail).toBe("decided in Use event ID as the idempotency key");
    expect(stepParts("Ship [[Plan|the plan]]")).toEqual({ title: "Ship the plan", detail: "" });
  });
});
