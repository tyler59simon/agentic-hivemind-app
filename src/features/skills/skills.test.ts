import { describe, expect, it } from "vitest";
import type { PauseKind, Skill } from "../../lib/skills";
import { copyPlace, lastRun, ledgerText, linkRef, linkState, parse, pauseChoices, PAUSE_WORDS, pausedSkills, proposalTitle, reliabilityText, runText, skillState, spendText, syncTitle } from "./skills";

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

const linked = (name: string, paused: PauseKind | null, over: Partial<Skill> = {}) => ({
  name, archived: false,
  link: { note: "n1", domain: "demo", title: "T", revision: "r", noteDigest: "d", version: 1, paused: paused && { kind: paused, reason: "why", at: 1, noteText: null, skillText: null } },
  ...over,
}) as Skill;

describe("skill sync words", () => {
  it("words every pause kind and the link chip", () => {
    expect(PAUSE_WORDS.conflict).toBe("The note and the skill both changed");
    expect(PAUSE_WORDS.invalid_note).toBe("The note is missing a section every skill needs");
    expect(PAUSE_WORDS.invalid_skill).toBe("The skill file is missing a section every skill needs");
    expect(PAUSE_WORDS.loose_text).toBe("The skill file has text above its first heading");
    expect(PAUSE_WORDS.copies_differ).toBe("The Claude Code and Codex copies were edited differently");
    expect(PAUSE_WORDS.note_missing).toBe("The note is gone, archived or no longer a runbook");
    expect(linkState(linked("a", null))?.label).toBe("Synced with note");
    expect(linkState(linked("a", "conflict"))).toEqual({ label: "Sync paused", tone: "waiting" });
    expect(linkState({ link: null })).toBeNull();
    expect(linkRef({ domain: "demo", note: "n1" })).toBe("demo:n1");
    expect(syncTitle("x")).toBe("Sync paused: x");
  });

  it("keeps every action enabled for every kind, with guidance for the fix-then-choose kinds", () => {
    const kinds: PauseKind[] = ["conflict", "invalid_note", "invalid_skill", "loose_text", "copies_differ", "note_missing"];
    for (const k of kinds) expect(Object.values(pauseChoices(k)).every((c) => c.enabled)).toBe(true);
    expect(pauseChoices("conflict").note.hint).toBeUndefined();
    expect(pauseChoices("invalid_note").note.hint).toBe("Add the missing section to the note, then choose Keep the note.");
    expect(pauseChoices("copies_differ").skill.hint).toContain("the same");
    expect(pauseChoices("copies_differ").skill.hint).toContain("A merge replaces both copies");
    expect(pauseChoices("note_missing").note.hint).toContain("active runbook");
  });

  it("lists the paused, unarchived skills", () => {
    const all = [linked("a", "conflict"), linked("b", null), linked("c", "conflict", { archived: true }), { name: "d", archived: false, link: null } as Skill];
    expect(pausedSkills(all).map((s) => s.name)).toEqual(["a"]);
  });

  it("words the sync ledger actions", () => {
    expect(ledgerText({ actor: "sync", action: "sync_from_note", version: 4 })).toBe("Hivemind (sync) updated the skill from its note (v4)");
    expect(ledgerText({ actor: "sync", action: "write_back", version: 5 })).toBe("Hivemind (sync) wrote the SKILL.md edit back to the note (v5)");
    expect(ledgerText({ actor: "sync", action: "sync_paused", version: null })).toBe("Hivemind (sync) paused sync with the note");
    expect(ledgerText({ actor: "sync", action: "sync_warning", version: null })).toBe("Hivemind (sync) hit a sync problem");
    expect(ledgerText({ actor: "user", action: "link", version: null })).toBe("You linked the skill to a note");
    expect(ledgerText({ actor: "user", action: "unlink", version: null })).toBe("You unlinked the skill from its note");
    expect(ledgerText({ actor: "user", action: "resolve_note", version: 6 })).toBe("You kept the note's text (v6)");
    expect(ledgerText({ actor: "user", action: "resolve_merge", version: 7 })).toBe("You saved a merged text (v7)");
    expect(ledgerText({ actor: "user", action: "uninstall_remove", version: null })).toBe("You removed a published copy for uninstall");
  });
});
