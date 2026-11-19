import { describe, expect, it } from "vitest";
import type { Briefing, CaptureItem, Health, Milestone } from "../../lib/executive";
import type { NoteRow, OpenItem, Project } from "../../lib/lm";
import { acceptKey, acceptWrite, blocked, commitmentsNote, hasAction, itemBody, planWrite, replaceable, tagsFor, type Context } from "./items";
import { addDays, commitmentRows, formatCommitment, parseCommitment, timing } from "./commitments";
import { healthView, signals, suggestHealth } from "./health";
import { attention, crossProject, portfolio } from "./portfolio";
import { allGaps, briefingMarkdown, edited, emlText, knownCitations, numbered, plainText, unsupported } from "./texts";

const TODAY = "2026-11-19";
const project = (slug: string, name: string, charter = `${slug}:c1`): Project => ({
  slug, name, status: "active", repos: [], aliases: [], description: "", charter, created: "", updated: "", tag: `project/${slug}`, tag_registered: true,
});
const PAY = project("pay", "PayStream");
const row = (o: Partial<NoteRow> & Pick<NoteRow, "ref" | "title" | "type">): NoteRow => ({
  id: o.ref.split(":")[1], domain: o.ref.split(":")[0], status: "active", tags: [], created: "", updated: "2026-11-18T10:00:00", revision: "r", path: "", ...o,
});
const item = (ref: string, text: string, index = 1): OpenItem => ({ ref, short_ref: ref, title: "Commitments: PayStream", type: "plan", updated: "", index, item: text });
const milestone = (o: Partial<Milestone>): Milestone => ({ id: "m1", created: 0, updated: 0, project: "pay", title: "Beta", due: "", status: "planned", note: "", ...o });
const extracted = (o: Partial<CaptureItem>): CaptureItem => ({
  id: "i1", kind: "decision", project: "pay", title: "Use event IDs as keys", summary: "Dedupe by event ID.", details: [], owner: "", due: "", quote: "we agreed on event ids",
  confidence: "high", similar: [], state: "pending", ...o,
});

describe("commitments", () => {
  it("reads and writes the owner and due convention", () => {
    expect(parseCommitment("Send the Q3 plan (owner: Dana, due: 2026-11-25)")).toEqual({ task: "Send the Q3 plan", owner: "Dana", due: "2026-11-25" });
    expect(parseCommitment("Send the plan (due: Friday)")).toEqual({ task: "Send the plan", owner: "", due: "" });
    expect(parseCommitment("Fix the build (see CI)")).toEqual({ task: "Fix the build (see CI)", owner: "", due: "" });
    expect(formatCommitment({ task: " Send it ", owner: "Dana", due: "2026-11-25" })).toBe("Send it (owner: Dana, due: 2026-11-25)");
    expect(formatCommitment({ task: "Send it", owner: "", due: "" })).toBe("Send it");
    const round = "Ship it (owner: Sam, due: 2026-12-01)";
    expect(formatCommitment(parseCommitment(round))).toBe(round);
  });

  it("sorts overdue first and knows what is due soon", () => {
    expect(timing("2026-11-18", TODAY)).toBe("overdue");
    expect(timing("2026-11-26", TODAY)).toBe("soon");
    expect(timing("2026-12-30", TODAY)).toBe("later");
    expect(timing("", TODAY)).toBe("undated");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    const rows = commitmentRows([item("p:1", "Later (due: 2026-12-30)", 1), item("p:1", "No date", 2), item("p:1", "Late (due: 2026-11-01)", 3)], TODAY);
    expect(rows.map((r) => r.task)).toEqual(["Late", "Later", "No date"]);
  });
});

describe("health", () => {
  it("suggests from the signals and lets the user's call win", () => {
    const calm = { overdueCommitments: 0, overdueMilestones: 0, milestonesAtRisk: 0, openRisks: 1, statusAge: 3 };
    expect(suggestHealth(calm).status).toBe("green");
    expect(suggestHealth({ ...calm, overdueCommitments: 1 })).toEqual({ status: "amber", reasons: ["1 commitment overdue"] });
    expect(suggestHealth({ ...calm, overdueMilestones: 1, statusAge: null }).reasons).toEqual(["1 milestone overdue", "no status update recorded"]);
    expect(suggestHealth({ ...calm, overdueCommitments: 3 }).status).toBe("red");
    const set: Health = { id: "pay", created: 0, updated: 0, project: "pay", status: "green", note: "Fine" };
    const view = healthView(set, suggestHealth({ ...calm, overdueCommitments: 1 }));
    expect([view.status, view.set, view.differs]).toEqual(["green", true, true]);
    expect(healthView(undefined, suggestHealth(calm))).toMatchObject({ status: "green", set: false, differs: false });
  });

  it("counts milestones: missed or past due is overdue, near or flagged is at risk, done is neither", () => {
    const s = signals([
      milestone({ id: "a", due: "2026-11-01" }), milestone({ id: "b", status: "missed" }), milestone({ id: "c", due: "2026-11-25" }),
      milestone({ id: "d", status: "at_risk", due: "2027-03-01" }), milestone({ id: "e", status: "done", due: "2026-10-01" }), milestone({ id: "f", due: "2027-05-01" }),
    ], [], 0, "2026-11-01T09:00:00", TODAY);
    expect(s).toEqual({ overdueCommitments: 0, overdueMilestones: 2, milestonesAtRisk: 2, openRisks: 0, statusAge: 18 });
  });
});

describe("capture", () => {
  const known = ["concern/decision", "concern/planning", "concern/knowledge", "project/pay", "subject/user"];
  const ctx: Context = { projects: [PAY], known, rows: [], defaultDomain: "pay", globalDomain: "_global", sourceLabel: "Standup", today: TODAY };

  it("picks tags the taxonomy has", () => {
    expect(tagsFor("decision", PAY, known)).toEqual(["concern/decision", "project/pay"]);
    expect(tagsFor("risk", PAY, known)).toEqual(["concern/knowledge", "project/pay"]);
    expect(tagsFor("preference", undefined, known)).toEqual(["concern/knowledge", "subject/user"]);
    expect(tagsFor("status", project("x", "X"), [])).toEqual([]);
  });

  it("offers to replace only a note in the domain the item is written to, and needs a project for a milestone", () => {
    expect(replaceable(extracted({}), "pay:old", ctx)).toBe(true);
    expect(replaceable(extracted({}), "led:old", ctx)).toBe(false);
    expect(replaceable(extracted({ kind: "commitment" }), "pay:old", ctx)).toBe(false);
    expect(replaceable(extracted({ kind: "preference", project: null }), "_global:p1", ctx)).toBe(true);
    expect(blocked(extracted({ kind: "milestone", project: null }))).toBe("A milestone needs a project.");
    expect(blocked(extracted({ kind: "milestone" }))).toBeUndefined();
  });

  it("writes a note with its source, and supersedes when asked", () => {
    const w = planWrite(extracted({ details: ["Saves a lookup"], owner: "Dana" }), ctx, "pay:old");
    expect(w.kind).toBe("note");
    if (w.kind !== "note") return;
    expect(w.domain).toBe("pay");
    expect(w.payload).toMatchObject({ title: "Use event IDs as keys", type: "decision", tags: ["concern/decision", "project/pay"], supersedes: ["pay:old"] });
    expect(w.payload.body).toBe('Dedupe by event ID.\n\n## Details\n- Saves a lookup\n- **Owner:** Dana\n\n## Source\nCaptured in Hivemind from "Standup" on 2026-11-19: "we agreed on event ids"');
    expect(itemBody(extracted({ quote: " " }), "Notes", TODAY)).toContain('from "Notes" on 2026-11-19.');
  });

  it("sends a writing preference with no project to the global domain", () => {
    const w = planWrite(extracted({ kind: "preference", project: null, title: "Writing preference: no greeting" }), ctx);
    expect(w.kind === "note" && w.domain).toBe("_global");
  });

  it("adds a commitment to the project's commitments note, or starts one", () => {
    const c = extracted({ kind: "commitment", title: "Send the Q3 plan", owner: "Dana", due: "2026-11-25" });
    const first = planWrite(c, ctx);
    expect(first.kind === "note" && first.payload).toMatchObject({ title: "Commitments: PayStream", type: "plan", tags: ["concern/planning", "project/pay"] });
    expect(first.kind === "note" && first.payload.body).toContain("## Action items\n- [ ] Send the Q3 plan (owner: Dana, due: 2026-11-25)");
    const rows = [row({ ref: "pay:c9", title: "Commitments: PayStream", type: "plan", tags: ["project/pay"] })];
    expect(planWrite(c, { ...ctx, rows })).toEqual({ kind: "action", ref: "pay:c9", text: "Send the Q3 plan (owner: Dana, due: 2026-11-25)" });
    expect(commitmentsNote(rows, undefined)).toBeUndefined();
    const cross = planWrite({ ...c, project: null }, ctx);
    expect(cross.kind === "note" && cross.payload.title).toBe("Commitments: Cross-project");
  });

  it("makes a milestone a Hivemind record", () => {
    expect(planWrite(extracted({ kind: "milestone", title: "Beta", due: "2026-12-05", summary: "First customers" }), ctx))
      .toEqual({ kind: "milestone", record: { project: "pay", title: "Beta", due: "2026-12-05", status: "planned", note: "First customers" } });
  });

  it("keys an accepted item so a retry finds the first write", () => {   // EXEC-3
    const key = acceptKey("0f9e8d7c6b5a49382716051423324150", "i3");
    expect(key).toBe("0f9e8d7c6b5a49382716051423324150-i3");
    expect(acceptKey("a/b", "i1")).toBeUndefined();
    expect(acceptKey("x".repeat(64), "i1")).toBeUndefined();
    const milestone = planWrite(extracted({ kind: "milestone", title: "Beta" }), ctx, undefined, key);
    expect(milestone.kind === "milestone" && milestone.record.id).toBe(key);
    const note = planWrite(extracted({}), ctx, undefined, key);
    expect(note.kind === "note" && note.payload.idempotency_key).toBe(`hivemind-capture-${key}`);
    const started = planWrite(extracted({ kind: "commitment", title: "Send the Q3 plan" }), ctx, undefined, key);
    expect(started.kind === "note" && started.payload.idempotency_key).toBe(`hivemind-capture-${key}`);
    const rows = [row({ ref: "pay:c9", title: "Commitments: PayStream", type: "plan", tags: ["project/pay"] })];
    const added = planWrite(extracted({ kind: "commitment", title: "Send the Q3 plan" }), { ...ctx, rows }, undefined, key);
    expect(added.kind === "action" && added.key).toBe(key);
    // A commitment added by hand has no key, so it is never taken for a retry (Codex R4).
    expect(planWrite(extracted({ kind: "commitment", title: "Send the Q3 plan" }), { ...ctx, rows })).not.toHaveProperty("key");
    const plain = planWrite(extracted({}), ctx);
    expect(plain.kind === "note" && plain.payload.idempotency_key).toBeUndefined();
    // The same item planned again is the same write, so Living Memory's key check matches it.
    expect(planWrite(extracted({}), ctx, undefined, key)).toEqual(note);
  });

  it("repeats the write an unfinished accept recorded, not one planned from later edits", () => {   // EXEC-3, Codex R3
    const item = extracted({ title: "Use event IDs as keys" });
    const first = acceptWrite(item, () => planWrite(item, ctx, "pay:old", "b-i1"), "pay:old");
    expect(first.fresh).toBe(true);
    expect(first.superseded).toBe("pay:old");
    const edited = { ...item, title: "Use event IDs as idempotency keys", intent: { write: first.write, superseded: first.superseded } };
    const again = acceptWrite(edited, () => planWrite(edited, ctx, undefined, "b-i1"));
    expect(again).toEqual({ write: first.write, superseded: "pay:old", fresh: false });
    expect(acceptWrite({ ...edited, intent: undefined }, () => planWrite(edited, ctx, undefined, "b-i1")).write).not.toEqual(first.write);
  });

  it("finds an action item a note already has, open or ticked", () => {   // EXEC-3
    const body = ["Commitments.", "", "## Action items", "- [ ] Send the Q3 plan (owner: Dana)", "- [x] Book the room", "", "## Details", "- [ ] Not an action"].join("\n");
    expect(hasAction(body, "Send the Q3 plan (owner: Dana)")).toBe(true);
    expect(hasAction(body, " Book the room ")).toBe(true);   // ticked since the earlier attempt (Codex re-review N1)
    expect(hasAction(body, "Not an action")).toBe(false);
    expect(hasAction(body, "Send the Q3 plan")).toBe(false);
  });
});

describe("portfolio", () => {
  const rows = [
    row({ ref: "pay:c9", title: "Commitments: PayStream", type: "plan", tags: ["project/pay"] }),
    row({ ref: "pay:r1", title: "Rate limit", type: "risk", tags: ["project/pay"] }),
    row({ ref: "pay:r2", title: "Old risk", type: "risk", tags: ["project/pay"], status: "resolved" }),
    row({ ref: "pay:s1", title: "Status", type: "status", tags: ["project/pay"], updated: "2026-11-17T09:00:00" }),
    row({ ref: "pay:x1", title: "Commitments: Cross-project", type: "plan", tags: ["concern/planning"] }),
    row({ ref: "led:d1", title: "Ledger decision", type: "decision", tags: ["project/led"] }),
  ];
  const items = [item("pay:c9", "Send the plan (owner: Dana, due: 2026-11-10)"), item("pay:x1", "Hire a lead (due: 2026-11-20)"), item("led:d1", "Nope")];
  const LED = project("led", "Ledger");

  it("builds one row per project, worst first", () => {
    const list = portfolio([LED, PAY, { ...project("old", "Old"), status: "archived" }], rows, items, [milestone({ due: "2026-11-28" })], [], TODAY);
    // Both are amber (Ledger has no status note), so they sort by name.
    expect(list.map((r) => [r.project.slug, r.health.status])).toEqual([["led", "amber"], ["pay", "amber"]]);
    const pay = list[1];
    expect([pay.health.status, pay.commitments.length, pay.risks.length, pay.next?.title, pay.latestStatus?.ref]).toEqual(["amber", 1, 1, "Beta", "pay:s1"]);
    expect(pay.health.suggestion.reasons).toContain("1 commitment overdue");
    const due = attention(list, TODAY);
    expect([due.overdue.length, due.milestones.length, due.atRisk.length]).toEqual([1, 1, 2]);
    expect(crossProject(items, rows, TODAY).map((c) => c.task)).toEqual(["Hire a lead"]);
    const paused = portfolio([{ ...LED, status: "paused" }, PAY], rows, items, [], [], TODAY);
    expect(attention(paused, TODAY).atRisk.map((r) => r.project.slug)).toEqual(["pay"]);
  });
});

describe("texts", () => {
  const b: Briefing = {
    id: "b", created: 0, updated: 0, kind: "weekly", project: null, days: 7, origin: "manual", title: "Week 47", summary: "Mostly on track.",
    sections: [{ heading: "Risks", bullets: [{ text: "Replays may hit the rate limit.", evidence: ["E2", "E9"] }, { text: "Unsupported claim.", evidence: [] }] }],
    gaps: ["No status for Ledger."], packGaps: ["No status for Ledger.", "No milestones."], costUsd: 0.1,
    evidence: [{ id: "E2", kind: "risk", title: "Rate limit", project: "PayStream", ref: "pay:r1", date: "2026-11-18", text: "" }],
  };

  it("keeps only real citations and counts unsupported bullets", () => {
    expect(knownCitations(["E2", "E9"], b.evidence)).toEqual(["E2"]);
    expect(unsupported(b)).toBe(1);
    expect(allGaps(b)).toEqual(["No status for Ledger.", "No milestones."]);
  });

  it("exports a briefing as Markdown with numbered sources", () => {
    expect(briefingMarkdown(b)).toBe(
      "# Week 47\n\nMostly on track.\n\n## Risks\n\n- Replays may hit the rate limit. [1]\n- Unsupported claim.\n\n## Missing or uncertain\n\n- No status for Ledger.\n- No milestones.\n\n## Sources\n\n1. Rate limit, PayStream, 2026-11-18\n");
  });

  it("numbers inline citations in the summary first and drops them from bullets", () => {
    const e = (id: string) => ({ ...b.evidence[0], id, title: id });
    const n = numbered({
      summary: "Beta holds [E5]. Two risks remain [E2, E9, E5].",
      sections: [{ heading: "Risks", bullets: [{ text: "Replays may hit the rate limit [E2].", evidence: ["E2", "E7"] }] }],
      evidence: [e("E2"), e("E5"), e("E7")],
    });
    expect(n.summary).toBe("Beta holds [1]. Two risks remain [2, 1].");
    expect(n.sections[0].bullets[0]).toEqual({ text: "Replays may hit the rate limit.", nums: [2, 3] });
    expect(n.cited.map((x) => x.id)).toEqual(["E5", "E2", "E7"]);
  });

  it("makes plain text and an unsent email", () => {
    expect(plainText("## Hi\n**Bold** and *it* [link](http://x)\n* item")).toBe("Hi\nBold and it link\n- item");
    expect(emlText("a@b.c", "Re:\nhi", "Line")).toBe("To: a@b.c\r\nSubject: Re: hi\r\nX-Unsent: 1\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLine");
  });

  it("learns only from real edits", () => {
    expect(edited("Hello there,\n\nThe plan ships Friday.", "Hello  there,\nThe plan ships Friday.")).toBe(false);
    expect(edited("The plan ships Friday.", "The plan ships Friday. Please confirm the budget by Monday.")).toBe(true);
    expect(edited("The plan ships Friday.", "The plan ships Monday.")).toBe(false);
  });
});
