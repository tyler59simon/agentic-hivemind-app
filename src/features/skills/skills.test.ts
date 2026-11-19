import { describe, expect, it } from "vitest";
import { copyPlace, lastRun, ledgerText, parse, proposalTitle, reliabilityText, runText, skillState, spendText } from "./skills";

const run = (o = {}) => ({ session: "s", title: "T", at: 0, trigger: "approved" as const, state: "staged" as const, memory: [], skill: null, skillName: null, skillApplied: false, costUsd: null, error: null, ...o });

describe("skill helpers", () => {
  it("states reliability as a count, or says there is none", () => {
    expect(reliabilityText({ approved: 4, rejected: 1, reliability: 0.8 })).toBe("4 of 5 approved (80%)");
    expect(reliabilityText({ approved: 0, rejected: 0, reliability: null })).toBe("No judged sessions yet");
  });

  it("picks the most urgent state", () => {
    const base = { archived: false, flagged: false, stale: false, copies: [{ dir: "x", state: "current" as const }] };
    expect(skillState(base).label).toBe("published");
    expect(skillState({ ...base, stale: true }).label).toBe("stale");
    expect(skillState({ ...base, stale: true, flagged: true }).label).toBe("flagged");
    expect(skillState({ ...base, flagged: true, copies: [{ dir: "x", state: "edited" }] }).label).toBe("edited outside Hivemind");
    expect(skillState({ ...base, archived: true, flagged: true }).label).toBe("archived");
    expect(skillState({ ...base, copies: [] }).label).toBe("not published");
  });

  it("names the CLI a copy belongs to", () => {
    expect(copyPlace("C:\\Users\\me\\.claude\\skills\\x")).toBe("Claude Code");
    expect(copyPlace("/home/me/.codex/skills/x")).toBe("Codex");
    expect(copyPlace("D:/scratch/x")).toBe("D:/scratch/x");
  });

  it("writes ledger rows and proposal titles", () => {
    expect(ledgerText({ actor: "user", action: "approve_patch", version: 3 })).toBe("You approved a change (v3)");
    expect(ledgerText({ actor: "user", action: "restore_v1", version: 4 })).toBe("You restored version 1 (v4)");
    expect(ledgerText({ actor: "auto", action: "something_new", version: null })).toBe("Hivemind (auto-patch) something new");
    expect(proposalTitle({ kind: "patch", name: "x" })).toBe("Change to x");
  });

  it("reads a SKILL.md the way Rust writes it", () => {
    expect(parse('---\r\nname: x\r\ndescription: "Use when: \\"a\\""\r\n---\r\n\r\n## Steps\r\n1. Go\r\n')).toEqual({ description: 'Use when: "a"', body: "## Steps\n1. Go" });
    expect(parse("---\nname: x\ndescription: plain words\n---\nBody")).toEqual({ description: "plain words", body: "Body" });
    expect(parse("No frontmatter")).toEqual({ description: "", body: "No frontmatter" });
  });

  it("sums up a review run", () => {
    expect(runText(run({ memory: [{ id: "a", title: "A" }, { id: "b", title: "B" }], skillName: "x" }))).toBe("2 notes proposed, skill x proposed");
    expect(runText(run({ skillName: "x", skillApplied: true, error: "e" }))).toBe("x updated (e)");
    expect(runText(run({ state: "nothing" }))).toBe("Nothing worth keeping");
    expect(runText(run({ state: "failed", error: "Today's learning budget is used" }))).toBe("Today's learning budget is used");
    expect(lastRun([run({ session: "a", at: 2 }), run({ session: "a", at: 1 })], "a")?.at).toBe(2);
    expect(spendText(0.312, 1)).toBe("$0.31 of $1.00 today");
  });
});
