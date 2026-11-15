import { describe, expect, it } from "vitest";
import type { SessionInfo, Worktree } from "../../lib/agent";
import { accessLabel, latestOf, statusLine, tabLabel, terminalTabs } from "./tabs";

let n = 0;
const wt: Worktree = { repo: "C:/src/app", path: "C:/wt/app", branch: "hivemind/x", baseBranch: "main", baseSha: "abc" };
const session = (o: Partial<SessionInfo>): SessionInfo => ({
  id: `s${++n}`, adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "paystream", repo: "C:/src/app" }, title: "t",
  workspace: [], status: "idle", startedAt: n, endedAt: null, costUsd: null, error: null, structured: null,
  mode: "interactive", policy: "ask", project: "paystream", worktree: wt, turns: 0, filesChanged: null, context: [], model: null, system: null,
  review: null, sourceSha: null, interface: "terminal", name: null, cliTitle: null, direct: null, noTask: false, access: null, effort: null, engineSession: null, ...o,
});

describe("terminal tabs", () => {
  it("names a session in a picked folder by the folder", () => {
    const folder = session({ task: { kind: "folder", path: "C:/Users/me/Notes/" }, project: null, worktree: null, noTask: true });
    expect(tabLabel(folder)).toBe("Claude Code · Notes");
    expect(tabLabel({ ...folder, adapter: "codex" })).toBe("Codex · Notes");
  });

  it("labels and lists the terminal tabs", () => {
    const codex = session({ adapter: "codex", task: { kind: "work", project: "p", repo: "C:\\src\\ingestion-service" }, noTask: true });
    expect(tabLabel(codex)).toBe("Codex · ingestion-service");
    expect(tabLabel(session({ task: { kind: "work", project: "p", repo: "/src/app/" }, noTask: true }))).toBe("Claude Code · app");
    expect(tabLabel({ ...codex, worktree: null })).toBe(tabLabel(codex));
    // With a task, the task names the tab until the CLI gives its own title.
    expect(tabLabel({ ...codex, noTask: false, title: "Fix the login redirect" })).toBe("Fix the login redirect");
    expect(tabLabel({ ...codex, noTask: false, title: " " })).toBe("Codex · ingestion-service");
    // The user's name wins over the CLI's title, which wins over the task and the default.
    expect(tabLabel({ ...codex, cliTitle: "Fix the importer" })).toBe("Fix the importer");
    expect(tabLabel({ ...codex, cliTitle: "Fix the importer", name: "Importer" })).toBe("Importer");
    expect(tabLabel({ ...codex, name: "  ", cliTitle: " " })).toBe("Codex · ingestion-service");

    const idle = session({ id: "idle", startedAt: 30 });
    const running = session({ id: "running", status: "running", startedAt: 10 });
    const ended = session({ id: "ended", status: "ended", startedAt: 20 });
    const chat = session({ id: "chat", interface: "chat", startedAt: 40 });
    const other = session({ id: "other", project: "other", startedAt: 50 });
    const all = [idle, running, ended, chat, other];
    expect(terminalTabs(all, "paystream").map((s) => s.id)).toEqual(["running", "idle"]);
    expect(terminalTabs(all, "paystream", "ended").map((s) => s.id)).toEqual(["running", "ended", "idle"]);
    expect(terminalTabs(all, null).map((s) => s.id)).toEqual(["running", "idle", "other"]);
    // The selected session is listed whatever its project or status.
    expect(terminalTabs(all, "paystream", "other").map((s) => s.id)).toEqual(["running", "idle", "other"]);
    // Sessions already in a pane stay when they end, or when they belong to another project.
    expect(terminalTabs(all, "paystream", undefined, ["ended"]).map((s) => s.id)).toEqual(["running", "ended", "idle"]);
    expect(terminalTabs(all, "paystream", undefined, ["other", "gone"]).map((s) => s.id)).toEqual(["running", "idle", "other"]);

    expect(latestOf(all, "paystream", "terminal")?.id).toBe("idle");
    expect(latestOf(all, "paystream", "chat")?.id).toBe("chat");
    expect(latestOf([chat], "paystream", "terminal")).toBeUndefined();
  });

  it("lists the sessions without a project under Other folders", () => {
    const inFolder = session({ id: "folder", task: { kind: "folder", path: "C:/Notes" }, project: null, worktree: null, direct: { path: "C:/Notes", repo: null, headSha: null, startTree: null } });
    const inProject = session({ id: "proj" });
    const all = [inFolder, inProject];
    expect(terminalTabs(all, "~other").map((s) => s.id)).toEqual(["folder"]);
    expect(terminalTabs(all, "paystream").map((s) => s.id)).toEqual(["proj"]);
    expect(terminalTabs(all, null).map((s) => s.id)).toEqual(["folder", "proj"]);
    expect(latestOf(all, "~other", "terminal")?.id).toBe("folder");
  });

  it("labels the access a session was started with in the CLI's words", () => {
    expect(accessLabel(session({ access: { engine: "claude", mode: "plan" } }))).toBe("plan");
    expect(accessLabel(session({ adapter: "codex", access: { engine: "codex", sandbox: "workspace-write", approval: "never" } }))).toBe("workspace-write · never");
  });

  it("labels access for each engine and policy", () => {
    expect(accessLabel(session({ adapter: "codex", policy: "accept_edits" }))).toBe("Workspace access");
    expect(accessLabel(session({ adapter: "codex", policy: "ask" }))).toBe("Read only, asks first");
    expect(accessLabel(session({ policy: "accept_edits" }))).toBe("Accept edits");
    expect(accessLabel(session({ policy: "ask" }))).toBe("Review edits");
  });

  it("words the status line", () => {
    for (const status of ["idle", "running", "ended", "failed"] as const) {
      expect(statusLine(session({ status }), true)).toEqual({ tone: "on", text: "Session active" });
    }
    expect(statusLine(session({ status: "idle" }), false)).toEqual({ tone: "off", text: "Starting…" });
    expect(statusLine(session({ status: "running" }), false)).toEqual({ tone: "off", text: "Starting…" });
    expect(statusLine(session({ status: "ended" }), false)).toEqual({ tone: "off", text: "Session ended" });
    expect(statusLine(session({ status: "failed", error: "The program exited with code 1." }), false))
      .toEqual({ tone: "failed", text: "Session failed · The program exited with code 1." });
    expect(statusLine(session({ status: "ended", worktree: null }), false).text).toBe("Session ended · worktree removed");
    expect(statusLine(session({ status: "failed", error: "x", worktree: null }), false).text).toBe("Session failed · x · worktree removed");
  });
});

describe("whereLabel", () => {
  it("names the branch, the checkout or the picked folder", async () => {
    const { whereLabel } = await import("./tabs");
    const base = session({});
    expect(whereLabel(base)).toBe("hivemind/x");
    const direct = { path: "C:/src/app", repo: "C:/src/app", headSha: null, startTree: null };
    expect(whereLabel({ ...base, worktree: null, direct })).toBe("your checkout");
    expect(whereLabel({ ...base, worktree: null, direct: { ...direct, path: "C:/Users/me/Notes" }, task: { kind: "folder", path: "C:/Users/me/Notes" } })).toBe("Notes");
    expect(whereLabel({ ...base, worktree: null })).toBe("worktree removed");
  });
});
