import { engineOf, type SessionInfo } from "../../lib/agent";
import { POLICIES, repoName } from "../agents/session";
import { engineName } from "../changes/changes";

const inProject = (s: SessionInfo, project: string | null) => project === null || s.project === project;

/** "Codex · ingestion-service": the engine and the repository's (or picked folder's) name. The task is used because the worktree can be gone. */
export function defaultLabel(s: SessionInfo): string {
  const repo = s.task.kind === "work" ? repoName(s.task.repo) : s.task.kind === "folder" ? repoName(s.task.path) : s.title;
  return `${engineName(s.adapter)} · ${repo}`;
}

/** The tab's text: the name the user gave, else the CLI's own title, else `defaultLabel`. */
export function tabLabel(s: SessionInfo): string {
  return s.name?.trim() || s.cliTitle?.trim() || defaultLabel(s);
}

/** The tab strip, oldest first: the project's terminal sessions that are idle or running, plus `selected` (whatever its project or status)
 *  and every session in `open` (already in a pane, whatever its status or project: a tab stays until the user closes it). */
export function terminalTabs(sessions: SessionInfo[], project: string | null, selected?: string, open: readonly string[] = []): SessionInfo[] {
  return sessions
    .filter((s) => s.interface === "terminal" && ((inProject(s, project) && (s.status === "idle" || s.status === "running")) || s.id === selected || open.includes(s.id)))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The session to show when the user switches to `face`: the most recently started one in the project, or undefined. */
export function latestOf(sessions: SessionInfo[], project: string | null, face: "chat" | "terminal"): SessionInfo | undefined {
  return sessions
    .filter((s) => s.interface === face && inProject(s, project))
    .reduce<SessionInfo | undefined>((best, s) => (best === undefined || s.startedAt > best.startedAt ? s : best), undefined);
}

/** The shield label in the toolbar for a terminal session. */
export function accessLabel(s: SessionInfo): string {
  if (engineOf(s) === "codex") return s.policy === "accept_edits" ? "Workspace access" : "Read only, asks first";
  return POLICIES.find((p) => p.id === s.policy)?.label ?? "Review edits";
}

/** "● Session active" and its siblings. */
export function statusLine(s: SessionInfo, running: boolean): { tone: "on" | "off" | "failed"; text: string } {
  if (running) return { tone: "on", text: "Session active" };
  const removed = s.worktree === null ? " · worktree removed" : "";
  if (s.status === "failed") return { tone: "failed", text: `Session failed${s.error ? ` · ${s.error}` : ""}${removed}` };
  if (s.status === "idle" || s.status === "running") return { tone: "off", text: "Starting…" };
  return { tone: "off", text: `Session ended${removed}` };
}
