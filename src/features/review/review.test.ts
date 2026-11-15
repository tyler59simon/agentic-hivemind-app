import { describe, expect, it } from "vitest";
import type { Review, SessionInfo } from "../../lib/agent";
import { afterDecision, proposedFiles, reviewLabel, reviewSessions, reviewVersion, sessionHeading, step } from "./review";

const tree = { repo: "C:/code/ingestion", path: "C:/data/worktrees/x/1", branch: "hivemind/1", baseBranch: "main", baseSha: "a".repeat(40) };
const base: SessionInfo = {
  id: "s", adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "p", repo: "C:/code/ingestion" }, title: "Add a flag",
  workspace: [], status: "idle", startedAt: 1, endedAt: null, costUsd: null, error: null, structured: null, mode: "interactive", policy: "ask",
  project: "p", worktree: tree, turns: 1, filesChanged: { files: 3, added: 4, removed: 1 }, context: [], model: null, system: null, review: null, sourceSha: null, interface: "chat", name: null, cliTitle: null,
};
const make = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ ...base, id, ...o });
const review = (state: Review["state"]): Review => ({ state, commit: null, at: 1 });
const files = (files: number) => ({ files, added: files, removed: 0 });

describe("review helpers", () => {
  const a = make("a");
  const b = make("b", { filesChanged: files(2), review: review("approved") });
  const c = make("c", { filesChanged: files(1), review: review("dismissed") });
  const d = make("d", { filesChanged: files(0) });
  const e = make("e", { filesChanged: files(2), review: review("changes_requested"), status: "running" });
  const f = make("f", { project: "other" });
  const g = make("g", { worktree: null });
  const all = [a, b, c, d, e, f, g];

  it("heads a session by its change", () => {
    const work = make("w", { task: { kind: "work", project: "p", repo: "r", change: 14 } });
    expect(sessionHeading(work, "CHG-014")).toBe("CHG-014 · Claude Code");
    expect(sessionHeading(work)).toBe("CHG-014 · Claude Code");
    expect(sessionHeading(a)).toBe("Add a flag");
  });

  it("lists sessions with undecided edits", () => {
    expect(reviewSessions(all, "p", undefined).map((s) => s.id)).toEqual(["a", "e"]);
    expect(reviewSessions(all, "p", "c").map((s) => s.id)).toEqual(["a", "c", "e"]);
    expect(reviewSessions(all, undefined, undefined).map((s) => s.id)).toEqual(["a", "e", "f"]);
  });

  it("reviewVersion changes with the worktree", () => {
    const v = reviewVersion(a);
    expect(reviewVersion(make("a"))).toBe(v);
    expect(reviewVersion(make("a", { turns: 2 }))).not.toBe(v);
    expect(reviewVersion(make("a", { filesChanged: files(4) }))).not.toBe(v);
    expect(reviewVersion(make("a", { filesChanged: { files: 3, added: 5, removed: 1 } }))).not.toBe(v);
    expect(reviewVersion(make("a", { filesChanged: { files: 3, added: 4, removed: 2 } }))).not.toBe(v);
    expect(reviewVersion(make("a", { worktree: { ...tree, reviewedSha: "b".repeat(40) } }))).not.toBe(v);
    expect(reviewVersion(make("a", { review: review("pending") }))).not.toBe(v);
  });

  it("reviewLabel names the state", () => {
    expect(reviewLabel(e)).toBeNull();
    expect(reviewLabel({ ...e, status: "idle" })).toEqual({ text: "Changes requested", tone: "busy" });
    expect(reviewLabel(a)).toEqual({ text: "Waiting for review", tone: "waiting" });
    expect(reviewLabel(b)).toEqual({ text: "Approved", tone: "active" });
    expect(reviewLabel(c)).toEqual({ text: "Dismissed", tone: "" });
    expect(reviewLabel(d)).toBeNull();
  });

  it("proposedFiles counts waiting sessions only", () => {
    expect(proposedFiles(reviewSessions(all, "p", undefined))).toBe(3);
  });

  it("step moves inside the list", () => {
    const keys = ["a", "b", "c"];
    expect(step(keys, "b", 1)).toBe("c");
    expect(step(keys, "b", -1)).toBe("a");
    expect(step(keys, "c", 1)).toBe("c");
    expect(step(keys, null, 1)).toBe("a");
    expect(step(keys, null, -1)).toBe("c");
    expect(step([], "a", 1)).toBeNull();
  });

  it("afterDecision goes to the next waiting session", () => {
    const w1 = make("a"), w2 = make("b"), done = make("c", { review: review("dismissed") });
    const listed = [w1, w2, done];
    expect(afterDecision(listed, "a")).toEqual({ page: "review", session: "b" });
    expect(afterDecision(listed, "b")).toEqual({ page: "review", session: "a" });
    expect(afterDecision(listed, "c")).toEqual({ page: "review", session: "a" });
    expect(afterDecision([w1], "a")).toEqual({ page: "review" });
    const never = [make("x", { status: "running" }), make("y", { review: review("approved") }), make("z")];
    expect(afterDecision(never, "z")).toEqual({ page: "review" });
  });
});
