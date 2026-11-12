import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/agent";
import type { Project } from "../../lib/lm";
import { draftCounts, permissionLines, sessionBriefing, sessionForNote, waitingForReview } from "./session";

let n = 0;
const session = (o: Partial<SessionInfo>): SessionInfo => ({
  id: `s${++n}`, adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "paystream", repo: "C:/code/ingestion" }, title: "t",
  workspace: [], status: "idle", startedAt: n, endedAt: null, costUsd: null, error: null, structured: null,
  mode: "interactive", policy: "ask", project: "paystream", worktree: null, turns: 0, filesChanged: null, context: [], model: null, system: null, ...o,
});
const project: Project = {
  slug: "paystream", name: "PayStream", status: "active", repos: ["C:/code/ingestion"], aliases: [], description: "",
  charter: "paystream:c1", created: "", updated: "", tag: "project/paystream", tag_registered: true,
};

describe("session helpers", () => {
  it("counts read like the mock", () => {
    expect(draftCounts(3, 1)).toBe("3 memory notes · 1 diagram · 1 repository");
    expect(draftCounts(1, 0)).toBe("1 memory note · 0 diagrams · 1 repository");
  });

  it("finds the session that works on a note", () => {
    const sessions = [
      session({ id: "ended", status: "ended", context: ["a:1"], startedAt: 50 }),
      session({ id: "unattended", mode: "unattended", context: ["a:1"], startedAt: 60 }),
      session({ id: "other", project: "other", context: ["a:1"], startedAt: 70 }),
      session({ id: "old", context: ["a:1"], startedAt: 10 }),
      session({ id: "new", context: ["a:1", "a:2"], startedAt: 20 }),
    ];
    expect(sessionForNote(sessions, "paystream", "a:1")?.id).toBe("new");
    expect(sessionForNote(sessions, "paystream", "a:9")).toBeUndefined();
  });

  it("waiting for review needs changes and a quiet session", () => {
    const totals = { files: 2, added: 3, removed: 1 };
    expect(waitingForReview(session({ status: "idle", filesChanged: totals }))).toBe(true);
    expect(waitingForReview(session({ status: "running", filesChanged: totals }))).toBe(false);
    expect(waitingForReview(session({ status: "idle", filesChanged: null }))).toBe(false);
  });

  it("permission lines follow the policy", () => {
    expect(permissionLines("ask")).toEqual(["File edits require review", "Commands ask unless already allowed"]);
    expect(permissionLines("accept_edits")).toEqual([
      "File edits apply without asking", "Simple file commands in the worktree may run without asking", "Other commands ask unless already allowed",
    ]);
    expect(permissionLines("pre_approved")).toEqual(["Unattended: pre-approved actions only"]);
  });
});

describe("sessionBriefing", () => {
  const pack = "# PayStream — project briefing\n\nCapture new notes for this project with `--project paystream`.\n";
  const note = (body: string) => ({ ref: "paystream:abc12345", title: "Use event ID as the idempotency key", type: "decision", body });
  const input = {
    project, domain: "paystream", repo: "C:/code/ingestion", branch: "main", policy: "ask" as const, pack,
    notes: [note("## 📌 Executive Summary\nEvent ID is the key.\n\n---\n## 📝 Key Details\n* Replays are safe\n")],
    architecture: { system: "Ingestion", generated: "2026-11-06", behind: 2, element: null, containers: ["API", "Worker"] },
    now: new Date("2026-11-09T12:00:00Z"),
  };

  it("the briefing names the workspace, the notes and the memory rules", () => {
    const text = sessionBriefing(input);
    expect(text).toContain("# Session briefing: PayStream");
    expect(text).toContain("Repository: C:/code/ingestion");
    expect(text).toContain("created from `main`");
    expect(text).toContain("### Use event ID as the idempotency key (decision, paystream:abc12345)");
    expect(text).toContain("Event ID is the key.");
    expect(text).toContain("2 commits behind");
    expect(text).toContain("`--project paystream`");
    expect(text).toContain("`--domain paystream`");
    expect(text.endsWith(pack)).toBe(true);

    const bare = sessionBriefing({ ...input, notes: [], architecture: null });
    expect(bare).not.toContain("## Included memory");
    expect(bare).not.toContain("## Architecture");

    const long = sessionBriefing({ ...input, notes: [note("## 📌 Executive Summary\n" + "x".repeat(5000))] });
    expect(long).toContain("x".repeat(1200));
    expect(long).not.toContain("x".repeat(1201));
  });

  it("the briefing describes the change", () => {
    const change = { display: "CHG-014", title: "Prevent duplicate payment alerts", stage: "Implement", briefTitle: "CHG-014 Prevent duplicate payment alerts", steps: ["Verify replay"], evidence: ["Replay produces no duplicate alert"] };
    const text = sessionBriefing({ ...input, change });
    expect(text).toContain("## Change");
    expect(text).toContain("CHG-014 Prevent duplicate payment alerts (stage: Implement)");
    expect(text).toContain("Open steps: Verify replay");
    expect(text).toContain("Acceptance evidence still to show: Replay produces no duplicate alert");
    expect(text).toContain("`--link '[[CHG-014 Prevent duplicate payment alerts]]'`");
    expect(text.indexOf("## Workspace")).toBeLessThan(text.indexOf("## Change"));
    expect(text.indexOf("## Change")).toBeLessThan(text.indexOf("## Included memory"));
    const empty = sessionBriefing({ ...input, change: { ...change, steps: [], evidence: [] } });
    expect(empty).not.toContain("Open steps");
    expect(empty).not.toContain("Acceptance evidence still to show");
    expect(sessionBriefing({ ...input, change: null })).toBe(sessionBriefing(input));
  });
});
