// Pure helpers for the Review page: which sessions it lists, how they are headed and labelled, and where it goes after a decision.
import type { SessionInfo } from "../../lib/agent";
import { waitingForReview } from "../agents/session";
import { displayId, engineName } from "../changes/changes";

export const fileKey = (sessionId: string, path: string) => `file:${sessionId}:${path}`;
export const baseName = (path: string) => path.split("/").pop() ?? path;

/** The change a session belongs to, if any. */
export const changeOf = (info: SessionInfo): number | undefined => (info.task.kind === "work" ? info.task.change ?? undefined : undefined);

/** "CHG-014 · Claude Code" for a session of a change, else the session's title. */
export function sessionHeading(info: SessionInfo, display?: string): string {
  const change = changeOf(info);
  return change === undefined ? info.title : `${display ?? displayId(change)} · ${engineName(info.adapter)}`;
}

/** The sessions the Code section lists: edits not yet approved or dismissed, plus the one the route names. */
export function reviewSessions(all: SessionInfo[], project: string | undefined, routed: string | undefined): SessionInfo[] {
  return all.filter((s) => s.worktree && (s.id === routed
    || ((s.filesChanged?.files ?? 0) > 0 && s.review?.state !== "approved" && s.review?.state !== "dismissed" && (!project || s.project === project))));
}

/** Changes whenever the worktree's listing can have changed. */
export const reviewVersion = (info: SessionInfo): string =>
  [info.turns, info.filesChanged?.files, info.filesChanged?.added, info.filesChanged?.removed, info.worktree?.reviewedSha, info.review?.at].join(":");

/** The chip for a session's review state, or null when there is nothing to say. */
export function reviewLabel(info: SessionInfo): { text: string; tone: "waiting" | "busy" | "active" | "" } | null {
  if (info.status === "running" || info.status === "waiting") return null;
  if (info.review?.state === "changes_requested") return { text: "Changes requested", tone: "busy" };
  if (waitingForReview(info)) return { text: "Waiting for review", tone: "waiting" };
  if (info.review?.state === "approved") return { text: "Approved", tone: "active" };
  if (info.review?.state === "dismissed") return { text: "Dismissed", tone: "" };
  return null;
}

/** Files proposed by sessions that wait for review. */
export const proposedFiles = (sessions: SessionInfo[]): number =>
  sessions.filter(waitingForReview).reduce((sum, s) => sum + (s.filesChanged?.files ?? 0), 0);

/** The key `delta` rows away from `current` in `keys`, staying inside the list. */
export function step(keys: string[], current: string | null, delta: 1 | -1): string | null {
  if (!keys.length) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  const from = at < 0 ? (delta > 0 ? -1 : keys.length) : at;
  return keys[Math.min(keys.length - 1, Math.max(0, from + delta))];
}

/** Where the page goes after a decision took `done` out of the queue: the next session that waits, else the bare page. */
export function afterDecision(listed: SessionInfo[], done: string): { page: "review"; session?: string } {
  const at = listed.findIndex((s) => s.id === done);
  for (let i = 1; i <= listed.length; i++) {
    const next = listed[(at + i + listed.length) % listed.length];
    if (next.id !== done && waitingForReview(next)) return { page: "review", session: next.id };
  }
  return { page: "review" };
}

/** "3 files", "1 file". */
export const filesWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
