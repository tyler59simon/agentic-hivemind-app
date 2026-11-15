import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/agent";
import type { TermInfo } from "../../lib/term";
import { runningSummary } from "./running";

const session = (o: Partial<SessionInfo>): SessionInfo => ({
  id: "s1", adapter: "claude-code", cliVersion: null, task: { kind: "work", project: "p", repo: "C:/src/paystream" }, title: "Fix login",
  workspace: [], status: "running", startedAt: 1, endedAt: null, costUsd: null, error: null, structured: null,
  mode: "interactive", policy: "ask", project: "p", worktree: null, turns: 0, filesChanged: null, context: [], model: null, system: null,
  review: null, sourceSha: null, interface: "chat", name: null, cliTitle: null, ...o,
});
const term = (o: Partial<TermInfo>): TermInfo => ({ id: "s1", sessionId: "s1", engine: "claude", running: true, exitCode: null, windowsBuild: null, ...o });

describe("runningSummary", () => {
  it("is empty when nothing runs", () => {
    expect(runningSummary([], [])).toEqual([]);
    expect(runningSummary([term({ running: false })], [session({ interface: "terminal", status: "ended" }), session({ id: "c", status: "succeeded" })])).toEqual([]);
  });

  it("lists running terminals and chat turns", () => {
    const sessions = [session({ id: "t", interface: "terminal" }), session({ id: "c", title: "Explain billing" }), session({ id: "w", status: "waiting", title: "Ask" }), session({ id: "d", status: "succeeded" })];
    const lines = runningSummary([term({ id: "t", sessionId: "t" }), term({ id: "login-codex", sessionId: null, engine: "codex" })], sessions);
    expect(lines).toEqual(["Claude Code · paystream (terminal)", "Codex sign-in (terminal)", "Chat turn · Explain billing", "Chat turn · Ask"]);
  });

  it("names a terminal as its tab does, with the user's rename", () => {
    const named = session({ id: "t", interface: "terminal", name: "Mine" });
    expect(runningSummary([term({ id: "t", sessionId: "t" })], [named])).toEqual(["Mine (terminal)"]);
  });
});
