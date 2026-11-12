import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionStatus } from "../../lib/agent";
import type { Change, LinkGraph, LinkNode, NoteRow, Status, System, NoteType } from "../../lib/lm";
import type { NoteLinks } from "../links/useLinks";
import {
  briefState, changeChip, changesFor, checkpointBody, checkpointTitle, connected, contextRefs, displayId, engineName, linkState,
  metaLines, nextStage, sessionLine, sessionsOf, stageStates, topChange, unadopted, viewOf, type ChangeView, type ViewContext,
} from "./changes";

const change = (o: Partial<Change> = {}): Change => ({
  id: 14, display: "CHG-014", title: "Prevent duplicate payment alerts", project: "paystream", brief: "demo:brief", stage: "implement", status: "active",
  repo: null, branch: null, system: null, element: null, created: "2026-11-01T00:00:00Z", updated: "2026-11-05T00:00:00Z",
  brief_status: "active", actions: { open: 2, done: 0 }, ...o,
});
let n = 0;
const session = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s" + ++n, adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "paystream", repo: "C:/r", change: 14 }, title: "Work",
  workspace: ["C:/r"], status: "idle", startedAt: 100, endedAt: null, costUsd: null, error: null, structured: null,
  mode: "interactive", policy: "ask", project: "paystream", worktree: null, turns: 0, filesChanged: null, context: [], model: null, system: null, ...o,
});
const node = (ref: string, type: NoteType = "decision", status: Status = "active", title = ref): LinkNode => ({ ref, id: ref, domain: "demo", title, type, status, tags: [] });
const graph = (nodes: LinkNode[], edges: LinkGraph["edges"]): LinkGraph => ({ domains: ["demo"], nodes, edges, unresolved: [] });
const row = (o: Partial<NoteRow>): NoteRow => ({
  ref: "demo:x", id: "x", domain: "demo", title: "X", type: "plan", status: "active", tags: [], created: "", updated: "2026-11-01", revision: "", path: "", ...o,
});
const system = (o: Partial<System> = {}): System => ({
  slug: "paystream", name: "Paystream", status: "active", description: "", owners: [], capabilities: [], repos: [], depends_on: [], architecture: "arch",
  passport: null, created: "", updated: "", tag: "", tag_registered: true, dependents: [], ...o,
});
const ctx = (o: Partial<ViewContext> = {}): ViewContext => ({ sessions: [], graph: undefined, due: new Set(), rows: new Map(), systems: [], ...o });

describe("change view model", () => {
  it("names the engine", () => {
    expect(engineName("claude-code")).toBe("Claude Code");
    expect(engineName("codex")).toBe("Codex");
    expect(engineName("other")).toBe("other");
  });

  it("formats display ids", () => {
    expect(displayId(1)).toBe("CHG-001");
    expect(displayId(14)).toBe("CHG-014");
    expect(displayId(1000)).toBe("CHG-1000");
  });

  it("stage states and the next stage", () => {
    const c = change();
    expect(stageStates(c)).toEqual(["done", "done", "current", "later"]);
    expect(nextStage(c)).toBe("validate");
    expect(nextStage(change({ stage: "validate" }))).toBeNull();
    const done = change({ status: "done" });
    expect(stageStates(done)).toEqual(["done", "done", "done", "done"]);
    expect(nextStage(done)).toBeNull();
    const cancelled = change({ status: "cancelled", stage: "design" });
    expect(stageStates(cancelled)).toEqual(["done", "current", "later", "later"]);
    expect(nextStage(cancelled)).toBeNull();
    for (const brief_status of [null, "archived", "superseded"] as const) expect(nextStage(change({ brief_status }))).toBeNull();
    expect(nextStage(change({ brief_status: "resolved" }))).toBe("validate");
  });

  it("brief state", () => {
    expect(briefState({ brief_status: null })).toBe("missing");
    expect(briefState({ brief_status: "archived" })).toBe("retired");
    expect(briefState({ brief_status: "superseded" })).toBe("retired");
    expect(briefState({ brief_status: "active" })).toBe("ok");
    expect(briefState({ brief_status: "resolved" })).toBe("ok");
  });

  it("link state of the Start screen", () => {
    const base = {
      change: 14 as number | null, changesOn: true, registryLoading: false, registryError: null as string | null, linked: change() as Change | undefined,
      branchesLoading: false, branchesError: null as string | null, applied: true, briefLoading: false, briefError: null as string | null,
    };
    const failed = (message: string) => ({ kind: "failed", message });
    const loading = (what: string) => ({ kind: "loading", what });
    expect(linkState(base)).toEqual({ kind: "ready" });
    expect(linkState({ ...base, change: null })).toEqual({ kind: "none" });
    expect(linkState({ ...base, changesOn: false })).toEqual(failed("CHG-014 cannot be loaded: this Living Memory has no changes command."));
    expect(linkState({ ...base, registryLoading: true })).toEqual(loading("Loading CHG-014…"));
    expect(linkState({ ...base, registryError: "boom" })).toEqual(failed("CHG-014 could not be loaded: boom"));
    expect(linkState({ ...base, linked: undefined })).toEqual(failed("CHG-014 is not in the change registry."));
    expect(linkState({ ...base, linked: change({ brief_status: null }) })).toEqual(failed("The brief of CHG-014 is missing, so its briefing cannot be built."));
    expect(linkState({ ...base, briefLoading: true })).toEqual(loading("Loading the brief of CHG-014…"));
    expect(linkState({ ...base, briefError: "gone" })).toEqual(failed("The brief of CHG-014 could not be loaded: gone"));
    expect(linkState({ ...base, branchesError: "not a repo" })).toEqual(failed("The branches for CHG-014 could not be read: not a repo"));
    expect(linkState({ ...base, branchesLoading: true })).toEqual(loading("Loading the repository and branch of CHG-014…"));
    expect(linkState({ ...base, applied: false })).toEqual(loading("Loading the repository and branch of CHG-014…"));
    expect(linkState({ ...base, linked: change({ brief_status: "archived" }) })).toEqual({ kind: "ready" });
    expect(linkState({ ...base, linked: change({ status: "done" }) })).toEqual({ kind: "ready" });
    expect(linkState({ ...base, registryLoading: true, briefLoading: true })).toEqual(loading("Loading CHG-014…"));
  });

  it("picks a change's sessions, newest first", () => {
    const a = session({ startedAt: 1 }), b = session({ startedAt: 5 });
    const passport = session({ task: { kind: "system_passport", slug: "x" }, startedAt: 9 });
    const plain = session({ task: { kind: "work", project: "paystream", repo: "C:/r" }, startedAt: 8 });
    const other = session({ task: { kind: "work", project: "paystream", repo: "C:/r", change: 3 }, startedAt: 7 });
    expect(sessionsOf(14, [a, passport, b, plain, other])).toEqual([b, a]);
  });

  it("chip order", () => {
    const c = change({ stage: "explore" });
    const label = (ch: Change, ss: SessionInfo[], due = false) => changeChip(ch, ss, due);
    expect(label(change({ status: "done" }), [session({ filesChanged: { files: 3, added: 0, removed: 0 } })])).toEqual({ label: "Done", tone: "active" });
    expect(label(change({ status: "cancelled" }), [])).toEqual({ label: "Cancelled", tone: "" });
    const review = session({ status: "idle", filesChanged: { files: 3, added: 0, removed: 0 } });
    expect(label(c, [review], true)).toEqual({ label: "Waiting for review", tone: "waiting" });
    expect(label(c, [], true)).toEqual({ label: "Needs review", tone: "" });
    expect(label(change({ stage: "implement" }), [], true).label).toBe("Needs review");
    expect(label(c, [session({ status: "running" })])).toEqual({ label: "In progress", tone: "busy" });
    expect(label(c, [session({ status: "waiting", filesChanged: { files: 3, added: 0, removed: 0 } })]).label).toBe("In progress");
    expect(label(change({ stage: "explore", actions: { open: 1, done: 1 } }), []).label).toBe("In progress");
    expect(label(change({ stage: "design" }), []).label).toBe("In progress");
    expect(label(c, [session({ status: "ended" })])).toEqual({ label: "Not started", tone: "" });
    expect(label(c, [])).toEqual({ label: "Not started", tone: "" });
  });

  it("session line", () => {
    expect(sessionLine(session({ status: "idle", filesChanged: { files: 3, added: 0, removed: 0 } }))).toBe("3 files awaiting review");
    expect(sessionLine(session({ status: "idle", turns: 2 }))).toBe("Ready · 2 turns");
    const line = (status: SessionStatus) => sessionLine(session({ status }));
    expect(line("running")).toBe("Working…");
    expect(line("waiting")).toBe("Waiting for you");
    expect(line("failed")).toBe("Failed");
    expect(line("cancelled")).toBe("Cancelled");
    expect(line("ended")).toBe("Ended");
    expect(line("succeeded")).toBe("Ended");
  });

  it("connected notes come from links in either direction", () => {
    const g = graph([node("demo:brief", "plan"), node("demo:d1"), node("demo:s1", "status"), node("demo:old")], [
      { from: "demo:brief", to: "demo:d1", kind: "link" },
      { from: "demo:s1", to: "demo:brief", kind: "link" },
      { from: "demo:old", to: "demo:brief", kind: "supersedes" },
      { from: "demo:d1", to: "demo:brief", kind: "link" },
    ]);
    expect(connected(g, "demo:brief").map((x) => x.ref)).toEqual(["demo:d1", "demo:s1"]);
    expect(connected(undefined, "demo:brief")).toEqual([]);
  });

  const joined = () => {
    const g = graph([
      node("demo:brief", "plan"), node("demo:d1", "decision"), node("demo:q1", "risk", "active"), node("demo:q2", "risk", "resolved"),
      node("demo:c1", "status", "active", "CHG-014 checkpoint 2026-11-08 10:00"), node("demo:c2", "status", "active", "CHG-014 checkpoint 2026-11-09 10:00"),
      node("demo:s1", "status", "active", "PayStream status: week of Nov 9"),
    ], ["demo:d1", "demo:q1", "demo:q2", "demo:c1", "demo:c2", "demo:s1"].map((to) => ({ from: "demo:brief", to, kind: "link" as const })));
    return g;
  };

  it("viewOf joins the sources", () => {
    const c = change({ system: "paystream" });
    const v = viewOf(c, ctx({ graph: joined(), rows: new Map([["demo:brief", row({ updated: "2026-11-09T00:00:00Z" })]]), systems: [system()] }));
    expect(v.decisions.map((x) => x.ref)).toEqual(["demo:d1"]);
    expect(v.questions.map((x) => x.ref)).toEqual(["demo:q1"]);
    expect(v.checkpoints.map((x) => x.ref)).toEqual(["demo:c2", "demo:c1"]);
    expect(v.updated).toBe("2026-11-09T00:00:00Z");
    expect(v.hasDiagram).toBe(true);
    expect(viewOf(c, ctx({ systems: [system({ architecture: null })] })).hasDiagram).toBe(false);
    expect(viewOf(c, ctx()).updated).toBe(c.updated);
  });

  it("meta lines", () => {
    const g = graph(
      [node("demo:brief", "plan"), ...["a", "b", "c"].map((x) => node("demo:" + x))],
      ["a", "b", "c"].map((x) => ({ from: "demo:brief", to: "demo:" + x, kind: "link" as const })),
    );
    const c = change({ system: "paystream" });
    const base = { graph: g, systems: [system()] };
    const waiting = session({ status: "idle", filesChanged: { files: 3, added: 0, removed: 0 } });
    const v = viewOf(c, ctx({ ...base, sessions: [waiting] }));
    expect(metaLines(v, "Nov 9")).toEqual({ first: ["Claude Code", "3 files proposed"], second: ["3 decisions", "1 diagram", "Updated Nov 9"] });
    const none = metaLines(viewOf(c, ctx(base)), "Nov 9");
    expect(none.first).toEqual([]);
    expect(none.second[0]).toBe("Implement");
    const one = session({ status: "running", filesChanged: { files: 1, added: 0, removed: 0 } });
    expect(metaLines(viewOf(change(), ctx({ sessions: [one] })), "x").first).toEqual(["Claude Code", "1 file changed"]);
    const g1 = graph([node("demo:brief", "plan"), node("demo:a")], [{ from: "demo:brief", to: "demo:a", kind: "link" }]);
    expect(metaLines(viewOf(change(), ctx({ graph: g1 })), "x").second).toContain("1 decision");
    expect(metaLines(viewOf(change({ brief_status: "archived" }), ctx()), "x").second[0]).toBe("Brief archived");
    expect(metaLines(viewOf(change({ brief_status: "superseded" }), ctx()), "x").second[0]).toBe("Brief superseded");
    expect(metaLines(viewOf(change({ brief_status: null }), ctx()), "x").second[0]).toBe("Brief missing");
    for (const s of ["active", "resolved"] as const) expect(metaLines(viewOf(change({ brief_status: s }), ctx()), "x").second[0]).toBe("Implement");
  });

  it("the top change", () => {
    const waitingSession = session({ status: "idle", filesChanged: { files: 2, added: 0, removed: 0 } });
    const older = viewOf(change({ id: 14, updated: "2026-11-01" }), ctx({ sessions: [waitingSession] }));
    const newer = viewOf(change({ id: 15, updated: "2026-11-09" }), ctx());
    const done = viewOf(change({ id: 16, status: "done", updated: "2026-11-10" }), ctx());
    expect(topChange([newer, older, done])).toBe(older);
    expect(topChange([newer, done])).toBe(newer);
    expect(topChange([done, viewOf(change({ status: "cancelled" }), ctx())])).toBeUndefined();
    expect(topChange([])).toBeUndefined();
  });

  it("changes of a note", () => {
    const c = change();
    const links = (incoming: string[], outgoing: string[]): NoteLinks => ({
      out: new Map(), unresolved: new Set(),
      incoming: incoming.map((r) => ({ node: node(r), kind: "link" as const })),
      outgoing: outgoing.map((r) => ({ node: node(r), kind: "link" as const })),
    });
    expect(changesFor("demo:brief", links([], []), [c])).toEqual([c]);
    expect(changesFor("demo:note", links([], ["demo:brief"]), [c])).toEqual([c]);
    expect(changesFor("demo:note", links(["demo:brief"], []), [c])).toEqual([c]);
    expect(changesFor("demo:note", links(["demo:other"], ["demo:else"]), [c])).toEqual([]);
  });

  it("plans without a change", () => {
    const rows = [
      row({ ref: "demo:brief" }), row({ ref: "demo:charter" }), row({ ref: "demo:old", status: "resolved" }), row({ ref: "demo:dec", type: "decision" }),
      row({ ref: "demo:a", updated: "2026-11-02" }), row({ ref: "demo:b", updated: "2026-11-05" }),
    ];
    expect(unadopted(rows, [change()], "demo:charter").map((r) => r.ref)).toEqual(["demo:b", "demo:a"]);
  });

  it("checkpoint title and body", () => {
    expect(checkpointTitle("CHG-014", new Date(2026, 10, 10, 14, 32))).toBe("CHG-014 checkpoint 2026-11-10 14:32");
    const p = { summary: "Halfway.", briefTitle: "CHG-014 Prevent duplicate payment alerts", stage: "implement" as const, branch: "feature/x", steps: { done: 2, total: 5 }, evidence: { done: 0, total: 2 } };
    const body = checkpointBody(p);
    expect(body.startsWith("## 📌 Executive Summary")).toBe(true);
    expect(body).toContain("* **Stage:** Implement");
    expect(body).toContain("* **Steps:** 2 of 5 done");
    expect(body).toContain("* **Evidence:** 0 of 2 verified");
    expect(body).toContain("* **Branch:** feature/x");
    expect(body.endsWith("* [[CHG-014 Prevent duplicate payment alerts]]")).toBe(true);
    expect(checkpointBody({ ...p, evidence: { done: 0, total: 0 }, branch: null })).not.toMatch(/Evidence|Branch/);
  });

  it("context refs", () => {
    const g = joined();
    const v: ChangeView = viewOf(change(), ctx({ graph: g }));
    expect(contextRefs(v)).toEqual(["demo:brief", "demo:d1", "demo:q1"]);
    expect(contextRefs({ ...v, decisions: [...v.decisions, v.questions[0]] })).toEqual(["demo:brief", "demo:d1", "demo:q1"]);
    expect(contextRefs(viewOf(change({ brief_status: null }), ctx({ graph: g })))).toEqual(["demo:d1", "demo:q1"]);
    expect(contextRefs(viewOf(change({ brief_status: "archived" }), ctx({ graph: g })))[0]).toBe("demo:brief");
  });
});
