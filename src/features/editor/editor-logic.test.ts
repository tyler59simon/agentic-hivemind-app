import { describe, expect, it } from "vitest";
import { hasConflictMarkers, mergeBody, mergeFields, MINE } from "./merge";
import { changedPayload, precheck, summaryOf, type Fields } from "./save";

const base: Fields = {
  title: "Cache", body: "The cache is rebuildable.\n\n## Details\n- a\n- b",
  type: "knowledge", tags: ["concern/knowledge", "subject/project"], context: "", review_by: "", files: [],
};

describe("changedPayload", () => {
  it("sends nothing when nothing changed (LM would still write)", () => {
    expect(changedPayload(base, { ...base, body: base.body + "\n\n", tags: [...base.tags].reverse() })).toEqual({});
  });

  it("sends only the fields that changed, review_by only when edited", () => {
    expect(changedPayload(base, { ...base, body: base.body + "\n* c" })).toEqual({ body: base.body + "\n* c" });
    expect(changedPayload(base, { ...base, title: " New ", tags: ["subject/project"] })).toEqual({ title: "New", tags: ["subject/project"] });
    expect(changedPayload({ ...base, review_by: "2027-01-01" }, { ...base, review_by: "" })).toEqual({ review_by: null });
    expect(changedPayload(base, { ...base, files: [" src/a.ts ", ""] })).toEqual({ files: ["src/a.ts"] });
  });
});

describe("precheck", () => {
  const tax = ["subject/project", "concern/knowledge", "concern/decision"];
  it("accepts a valid note", () => expect(precheck(base, tax, true)).toEqual([]));
  it("mirrors LM's layout and tag rules", () => {
    expect(precheck({ ...base, body: "## Details\n- x" }, tax, false)).toEqual([expect.stringContaining("Write a summary")]);
    expect(precheck({ ...base, body: "## Why\nBecause." }, tax, false)).toEqual([expect.stringContaining("Write a summary")]);
    expect(precheck({ ...base, body: base.body + "\n\n## Action items\n- [ ] do it" }, tax, false))
      .toEqual([expect.stringContaining("Action items are only")]);
    expect(precheck({ ...base, body: base.body + "\n\n## 🟩 Action Items\n- [ ] legacy heading" }, tax, false))
      .toEqual([expect.stringContaining("Action items are only")]);
    expect(precheck({ ...base, body: base.body + "\n\n## Action items\n- [ ] " }, tax, false)).toEqual([]);
    expect(precheck({ ...base, type: "plan", body: base.body + "\n\n## Action items\n- [ ] do it" }, tax, false)).toEqual([]);
    expect(precheck({ ...base, tags: ["subject/project", "concern/new"] }, tax, true)).toEqual([expect.stringContaining("concern/new")]);
    expect(precheck({ ...base, tags: ["subject/project"] }, tax, true)).toEqual([expect.stringContaining("concern/")]);
    expect(precheck({ ...base, tags: ["subject/project"] }, tax, false)).toEqual([]); // updates are not held to new-note facets
    expect(precheck({ ...base, review_by: "soon" }, tax, false)).toEqual([expect.stringContaining("YYYY-MM-DD")]);
  });
  it("finds the summary the way LM's formatter does", () => {
    expect(summaryOf("Lead text\n\n## Details\n- x")).toBe("Lead text");
    expect(summaryOf("Lead text\n\n> **Important:** careful\n\n## Why\nBecause.")).toBe("Lead text");
    expect(summaryOf("## 📌 Executive Summary\nLegacy summary.\n\n---\n\n## 📝 Key Details\n* x")).toBe("Legacy summary.");
    // A named first section is not the summary (LM changed this with the headless summary).
    expect(summaryOf("## Notes\nFirst custom section")).toBe("");
    expect(summaryOf("## Details\n- x")).toBe("");
  });
});

describe("merge", () => {
  it("merges edits to different lines without conflict", () => {
    // Edits to adjacent lines conflict (as in git), so these are far apart.
    const theirs = base.body.replace("The cache is rebuildable.", "The cache is rebuilt nightly.");
    const mine = base.body.replace("- b", "- b (mine)");
    const out = mergeBody(base.body, mine, theirs);
    expect(out.conflicts).toBe(0);
    expect(out.text).toContain("rebuilt nightly");
    expect(out.text).toContain("- b (mine)");
  });

  it("marks edits to the same line as a conflict", () => {
    const out = mergeBody(base.body, base.body.replace("- a", "- mine"), base.body.replace("- a", "- theirs"));
    expect(out.conflicts).toBe(1);
    expect(out.text).toContain(`<<<<<<< ${MINE}`);
    expect(hasConflictMarkers(out.text)).toBe(true);
    expect(hasConflictMarkers(base.body)).toBe(false);
  });

  it("merges properties field by field", () => {
    const mine = { ...base, title: "Mine", tags: ["subject/project"] };
    const theirs = { ...base, title: "Theirs", context: "ctx" };
    const out = mergeFields(base, mine, theirs);
    expect(out.conflicts).toEqual(["title"]);
    expect(out.merged.tags).toEqual(["subject/project"]); // only I changed tags
    expect(out.merged.context).toBe("ctx");               // only they changed context
  });
});
