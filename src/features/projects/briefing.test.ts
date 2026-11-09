import { describe, expect, it } from "vitest";
import type { NoteRow, OpenItem, Project } from "../../lib/lm";
import { buildBriefing, isoDay, shortRef } from "./briefing";

const project: Project = {
  slug: "hivemind", name: "Hivemind", status: "active", repos: ["C:/Sandbox/agentic-hivemind"], aliases: [],
  description: "Desktop app over LM.", charter: "sandbox:c1", created: "", updated: "", tag: "project/hivemind", tag_registered: true,
};
const charter = { title: "Charter", body: "## 📌 Executive Summary\nBuild the cockpit.\n\n---\n## 📝 Key Details\n* Tauri 2\n" };
let n = 0;
const row = (o: Partial<NoteRow>): NoteRow => ({
  ref: `sandbox:id${++n}`, id: `id${n}`, domain: "sandbox", title: `Note ${n}`, type: "knowledge", status: "active",
  tags: [project.tag], created: `2026-01-${String(10 + (n % 15)).padStart(2, "0")}`, updated: "", revision: "r", path: "", ...o,
});
const item = (o: Partial<OpenItem>): OpenItem => ({
  ref: "sandbox:p1", short_ref: "p1", title: "Plan A", type: "plan", updated: "", index: 1, item: "Do it", ...o,
});
const now = new Date("2026-11-09T12:00:00Z");

describe("helpers", () => {
  it("formats days and refs", () => {
    expect(isoDay("2026-03-04T10:00:00Z")).toBe("2026-03-04");
    expect(isoDay(now)).toBe("2026-11-09");
    expect(shortRef("sandbox:abcdef123456")).toBe("abcdef12");
  });
});

describe("buildBriefing", () => {
  const rows = [
    row({ type: "decision", title: "Old decision", created: "2026-01-01", summary: "Chose A." }),
    row({ type: "decision", title: "New decision", created: "2026-02-01" }),
    row({ type: "decision", title: "Archived", status: "archived", created: "2026-03-01" }),
    row({ type: "risk", title: "A risk", summary: "Might break." }),
    row({ type: "bug", title: "A bug" }),
    row({ type: "plan", title: "Roadmap", actions: { open: 2, done: 1 } }),
    row({ type: "status", title: "Old status", created: "2026-01-02", summary: "Old." }),
    row({ type: "status", title: "New status", created: "2026-04-02", summary: "Doing H4." }),
  ];
  const commits = Array.from({ length: 12 }, (_, i) => ({ sha: `abcdef${i}123`, subject: `Commit ${i}`, date: "2026-11-01" }));
  const open = [item({}), item({ ref: "sandbox:p2", short_ref: "p2", title: "Plan B", item: "Other" })];
  const text = buildBriefing({ project, charter, rows, open, commits, now });

  it("has sections in order", () => {
    const heads = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["Project", "Charter", "Open work", "Decisions", "Risks and open bugs", "Plans", "Latest status", "Recent commits"]);
    expect(text.startsWith("# Hivemind — project briefing\n\n> Reference only: generated from Living Memory on 2026-11-09. Verify against the current code before acting.")).toBe(true);
    expect(text.trimEnd().endsWith("Capture new notes for this project with `--project hivemind`.")).toBe(true);
  });
  it("has content", () => {
    expect(text).toContain("Build the cockpit.");
    expect(text).toContain("* Tauri 2");
    expect(text).toContain("- [ ] Do it (Plan A · p1)");
    expect(text.indexOf("New decision")).toBeLessThan(text.indexOf("Old decision"));
    expect(text).toContain("- **Old decision** (2026-01-01, sandbox:id1) — Chose A.");
    expect(text).not.toContain("Archived");
    expect(text).toContain("A bug");
    expect(text).toContain("1/3 done");
    expect(text).toContain("Doing H4.");
    expect(text).not.toContain("Old status");
    expect(text).toContain("- abcdef0 Commit 0 (2026-11-01)");
    expect(text).not.toContain("Commit 10");
    expect(text).not.toContain("truncated");
  });
  it("omits empty sections", () => {
    const t = buildBriefing({ project, rows: [], open: [], now });
    expect([...t.matchAll(/^## (.*)$/gm)].map((m) => m[1])).toEqual(["Project"]);
  });
  it("caps decisions at 15", () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ type: "decision", title: `D${i}` }));
    const t = buildBriefing({ project, rows: many, open: [], now, maxChars: 100000 });
    expect(t.match(/^- \*\*D/gm)).toHaveLength(15);
  });
  it("truncates lowest priority first and keeps header and footer", () => {
    const t1 = buildBriefing({ project, charter, rows, open, commits, now, maxChars: text.length - 10 });
    expect(t1).toContain("truncated");
    expect(t1).toContain("Commit 0");
    expect(t1).not.toContain("Commit 9");
    expect(t1).toContain("Roadmap");
    const tiny = buildBriefing({ project, charter, rows, open, commits, now, maxChars: 1 });
    for (const gone of ["Recent commits", "Roadmap", "A risk", "Decisions", "Do it"]) expect(tiny).not.toContain(gone);
    expect(tiny).toContain("# Hivemind — project briefing");
    expect(tiny).toContain("truncated");
    expect(tiny.trimEnd().endsWith("--project hivemind`.")).toBe(true);
  });
  it("drops plans before risks before decisions before open items", () => {
    const base = { project, rows, open, now };
    const size = buildBriefing({ ...base, maxChars: 100000 }).length;
    const t = buildBriefing({ ...base, maxChars: size - 1 });
    expect(t).not.toContain("Roadmap");
    expect(t).toContain("A risk");
    expect(t).toContain("New decision");
    expect(t).toContain("Do it");
  });
});
