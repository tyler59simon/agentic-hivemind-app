import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/agent";
import type { Project } from "../../lib/lm";
import { changeRows, codexPermissionLines, draftCounts, engineLabel, isCodex, isUnattended, permissionLines, POLICIES, policyHelp, resumeCommand, relativeTo, sessionBriefing, sessionForNote, usageText, waitingForReview } from "./session";

let n = 0;
const session = (o: Partial<SessionInfo>): SessionInfo => ({
  id: `s${++n}`, adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "paystream", repo: "C:/code/ingestion" }, title: "t",
  workspace: [], status: "idle", startedAt: n, endedAt: null, costUsd: null, error: null, structured: null,
  mode: "interactive", policy: "ask", project: "paystream", worktree: null, turns: 0, filesChanged: null, context: [], model: null, system: null, review: null, sourceSha: null, interface: "chat", name: null, cliTitle: null, direct: null, noTask: false, access: null, effort: null, engineSession: null, role: null, profile: null, summary: null, verdict: null, ...o,
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
    const state = (s: NonNullable<SessionInfo["review"]>["state"]) => ({ state: s, commit: null, at: 1 });
    const a = session({ status: "idle", filesChanged: totals });
    const b = session({ status: "idle", filesChanged: totals, review: state("approved") });
    const c = session({ status: "idle", filesChanged: totals, review: state("dismissed") });
    const d = session({ status: "idle", filesChanged: { files: 0, added: 0, removed: 0 } });
    const e = session({ status: "idle", filesChanged: totals, review: state("changes_requested") });
    expect(waitingForReview(a)).toBe(true);
    expect(waitingForReview({ ...a, review: state("pending") })).toBe(true);
    for (const x of [b, c, d, e]) expect(waitingForReview(x)).toBe(false);
    expect(waitingForReview({ ...a, status: "waiting" })).toBe(false);
    expect(waitingForReview({ ...a, status: "running" })).toBe(false);
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

describe("role and resource helpers", () => {
  it("calls only a pre-approved editing session unattended", () => {
    expect(isUnattended({ profile: "edit_worktree", policy: "pre_approved" })).toBe(true);
    expect(isUnattended({ profile: "edit_worktree", policy: "accept_edits" })).toBe(false);
    expect(isUnattended({ profile: "read_only", policy: "pre_approved" })).toBe(false);
    expect(isUnattended({ profile: null, policy: "pre_approved" })).toBe(false);
  });

  it("writes CPU, memory and process count", () => {
    expect(usageText({ cpu: 12.4, memoryMb: 340.6, processes: 3 })).toBe("12% CPU · 341 MB · 3 processes");
    expect(usageText({ cpu: 0, memoryMb: 2048, processes: 1 })).toBe("0% CPU · 2.0 GB · 1 process");
  });
});

describe("sessionBriefing", () => {
  const pack = "# PayStream — project briefing\n\nCapture new notes for this project with `--project paystream`.\n";
  const note = (body: string) => ({ ref: "paystream:abc12345", title: "Use event ID as the idempotency key", type: "decision", body });
  const input = {
    project, domain: "paystream", repo: "C:/code/ingestion", branch: "main", policy: "ask" as const, pack,
    notes: [note("Event ID is the key.\n\n## Details\n- Replays are safe\n")],
    architecture: { system: "Ingestion", generated: "2026-11-06", behind: 2, element: null, containers: ["API", "Worker"] },
    now: new Date("2026-11-09T12:00:00Z"),
  };

  it("a terminal in the checkout does not claim a worktree or a permission rule", () => {
    const text = sessionBriefing({ ...input, place: "checkout" });
    expect(text).toContain("own checkout");
    expect(text).not.toContain("worktree");
    expect(text).not.toContain("created from");
    expect(text).not.toContain("File edits");
    expect(sessionBriefing({ ...input, place: "worktree" })).toContain("created from `main`");
    expect(sessionBriefing({ ...input, place: "worktree" })).not.toContain("File edits");
  });

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

    const long = sessionBriefing({ ...input, notes: [note("x".repeat(5000))] });
    expect(long).toContain("x".repeat(1200));
    expect(long).not.toContain("x".repeat(1201));
  });

  it("knows a Codex session", () => {
    expect(isCodex(session({ adapter: "codex" }))).toBe(true);
    expect(isCodex(session({}))).toBe(false);
    expect(engineLabel(session({ adapter: "codex" }))).toBe("Codex");
    expect(engineLabel(session({}))).toBe("Claude Code");
  });

  it("words a Codex chat's permissions by its policy", () => {
    expect(codexPermissionLines("ask")).toEqual(["File edits require review", "Commands ask unless Codex trusts them as read-only"]);
    expect(codexPermissionLines("accept_edits")[0]).toBe("File edits and commands in the worktree run without asking");
    expect(policyHelp("accept_edits", true)).toBe("File edits and commands in the worktree run without asking. Codex asks before it goes outside its sandbox.");
    expect(policyHelp("ask", false)).toBe(POLICIES[0].help);
  });

  it("builds the resume command for the session's engine", () => {
    expect(resumeCommand(session({ id: "S" }))).toBe("claude --resume S");
    expect(resumeCommand(session({ adapter: "codex", engineSession: "T" }))).toBe("codex resume T");
    expect(resumeCommand(session({ adapter: "codex", engineSession: null }))).toBeNull();
  });

  it("shows a path relative to the worktree when it is inside", () => {
    expect(relativeTo("C:\\work\\wt\\src\\a.ts", "c:/work/wt")).toBe("src/a.ts");
    expect(relativeTo("C:\\work\\wt2\\a.ts", "C:\\work\\wt")).toBe("C:\\work\\wt2\\a.ts");
    expect(relativeTo("/tmp/x.txt", null)).toBe("/tmp/x.txt");
  });

  it("turns Codex changes into rows, and ignores other inputs", () => {
    const input = { changes: [{ path: "C:\\work\\wt\\as-patch.txt", kind: { type: "add" }, diff: "hi\n" }, { path: "b.txt" }] };
    expect(changeRows(input, "C:\\work\\wt")).toEqual([{ path: "as-patch.txt", diff: "hi\n" }, { path: "b.txt", diff: "" }]);
    expect(changeRows({ file_path: "a.ts", old_string: "x", new_string: "y" })).toBeNull();
    expect(changeRows(undefined)).toBeNull();
  });
});
