import { describe, expect, it } from "vitest";
import type { AgentModels, SessionInfo } from "../../lib/agent";
import { accessLines, buildStart, defaultAccess, effortOptions, terminalsIn, withApproval, type StartForm } from "./start";

const form = (o: Partial<StartForm> = {}): StartForm => ({
  engine: "claude", face: "terminal", where: "checkout", project: "paystream", repo: "C:/src/app", branch: "main", change: null, folder: null,
  task: "  Fix it  ", policy: "ask", access: defaultAccess("claude"), model: "", effort: "", context: ["a:1"], briefing: "BRIEF", system: "ingestion", ...o,
});

describe("buildStart", () => {
  it("starts a terminal in the checkout with no branch", () => {
    const r = buildStart(form());
    expect(r.task).toEqual({ kind: "work", project: "paystream", repo: "C:/src/app" });
    expect(r.prompt).toBe("Fix it");
    expect(r.options).toEqual({ policy: "ask", context: ["a:1"], briefing: "BRIEF", system: "ingestion", engine: "claude", interface: "terminal", place: "checkout", access: { engine: "claude", mode: "manual" } });
  });

  it("starts a terminal in a new worktree on the picked branch, linked to a change", () => {
    const r = buildStart(form({ where: "worktree", change: 7 }));
    expect(r.task).toEqual({ kind: "work", project: "paystream", repo: "C:/src/app", branch: "main", change: 7 });
    expect(r.options.place).toBe("worktree");
  });

  it("starts a terminal in a folder with no briefing, notes or system, with or without a project", () => {
    for (const project of ["paystream", null]) {
      const r = buildStart(form({ where: "folder", project, folder: "C:/Notes" }));
      expect(r.task).toEqual({ kind: "folder", path: "C:/Notes" });
      expect(r.options.briefing).toBeUndefined();
      expect(r.options.place).toBeUndefined();
      expect(r.options.system).toBeUndefined();
      expect(r.options.context).toEqual([]);
    }
    // Under Other folders the folder is used whatever `where` says.
    expect(buildStart(form({ project: null, where: "checkout", folder: "C:/Notes" })).task).toEqual({ kind: "folder", path: "C:/Notes" });
    expect(() => buildStart(form({ where: "folder", folder: null }))).toThrow();
  });

  it("allows an empty task in a terminal", () => {
    expect(buildStart(form({ task: "   " })).prompt).toBe("");
  });

  it("sends model and effort only when set, and confirmedRisky only for modes that never ask", () => {
    const plain = buildStart(form()).options;
    expect("model" in plain || "effort" in plain || "confirmedRisky" in plain).toBe(false);
    const set = buildStart(form({ model: "opus", effort: "high", access: { engine: "claude", mode: "bypassPermissions" } })).options;
    expect(set).toMatchObject({ model: "opus", effort: "high", confirmedRisky: true, access: { engine: "claude", mode: "bypassPermissions" } });
    const codex = buildStart(form({ engine: "codex", access: { engine: "codex", sandbox: "workspace-write", approval: "approve-for-me" } })).options;
    expect(codex).toMatchObject({ engine: "codex", confirmedRisky: true });
    expect(buildStart(form({ engine: "codex", access: defaultAccess("codex") })).options.confirmedRisky).toBeUndefined();
  });

  it("keeps chat as it was: a worktree task on a branch, the policy, a Claude model, no access or effort", () => {
    const r = buildStart(form({ face: "chat", where: "checkout", model: "sonnet", effort: "high", task: "Do it" }));
    expect(r.task).toEqual({ kind: "work", project: "paystream", repo: "C:/src/app", branch: "main" });
    expect(r.options).toEqual({ policy: "ask", context: ["a:1"], briefing: "BRIEF", model: "sonnet", system: "ingestion", engine: "claude", interface: "chat" });
    expect(() => buildStart(form({ face: "chat", project: null }))).toThrow();
  });
});

describe("access helpers", () => {
  it("approve-for-me forces the workspace-write sandbox", () => {
    const base = defaultAccess("codex");
    if (base.engine !== "codex") throw new Error();
    expect(withApproval(base, "approve-for-me")).toEqual({ engine: "codex", sandbox: "workspace-write", approval: "approve-for-me" });
    expect(withApproval({ ...base, sandbox: "danger-full-access" }, "never")).toEqual({ engine: "codex", sandbox: "danger-full-access", approval: "never" });
    expect(defaultAccess("claude")).toEqual({ engine: "claude", mode: "manual" });
    expect(defaultAccess("codex")).toEqual({ engine: "codex", sandbox: "read-only", approval: "on-request" });
  });

  it("describes an access in the CLI's words", () => {
    expect(accessLines({ engine: "claude", mode: "plan" })[0]).toBe("plan");
    expect(accessLines({ engine: "codex", sandbox: "read-only", approval: "on-request" })).toHaveLength(3);
  });
});

describe("effortOptions", () => {
  const models: AgentModels = {
    models: [{ id: "a", label: "A", efforts: ["low", "high"], defaultEffort: null }, { id: "b", label: "B", efforts: ["high", "xhigh"], defaultEffort: null }],
    defaultModel: "b", defaultEffort: null, note: null,
  };
  it("follows the chosen model, else the CLI's default model, else every effort", () => {
    expect(effortOptions(models, "a")).toEqual(["low", "high"]);
    expect(effortOptions(models, "")).toEqual(["high", "xhigh"]);
    expect(effortOptions({ ...models, defaultModel: null }, "")).toEqual(["low", "high", "xhigh"]);
    expect(effortOptions(undefined, "a")).toEqual([]);
  });
});

describe("terminalsIn", () => {
  const s = (o: Partial<SessionInfo>) => ({ id: "x", interface: "terminal", status: "idle", direct: { path: "C:\\Src\\App", repo: null, headSha: null, startTree: null }, ...o }) as SessionInfo;
  it("finds open terminals in the same folder, ignoring case and slashes", () => {
    const hit = s({ id: "hit" });
    const all = [hit, s({ id: "running", status: "running" }), s({ id: "ended", status: "ended" }), s({ id: "chat", interface: "chat" }),
      s({ id: "worktree", direct: null }), s({ id: "elsewhere", direct: { path: "C:/other", repo: null, headSha: null, startTree: null } })];
    expect(terminalsIn(all, "c:/src/app/").map((x) => x.id)).toEqual(["hit", "running"]);
  });
});
