// Pure helpers for the Inbox's code group: which sessions it lists, how they are headed and labelled, and where it goes after a decision.
import type { SessionInfo } from "../../lib/agent";
import { waitingForReview } from "../agents/session";

export const fileKey = (sessionId: string, path: string) => `file:${sessionId}:${path}`;
export const baseName = (path: string) => path.split("/").pop() ?? path;

/** The sessions the Code section lists: edits not yet approved or dismissed, plus the one the route names. */
export function reviewSessions(all: SessionInfo[], project: string | undefined, routed: string | undefined): SessionInfo[] {
  return all.filter((s) => (s.worktree || s.direct) && (s.id === routed
    || ((s.filesChanged?.files ?? 0) > 0 && s.review?.state !== "approved" && s.review?.state !== "dismissed" && (!project || s.project === project))));
}

export const DIRECT_NOTE = "These edits are in your real files. Commit them yourself.";
export const EARLIER_NOTE = "Includes edits made before this session.";
export const NOT_GIT_NOTE = "This folder is not a git repository; Hivemind cannot show what changed.";

/** What a session in the user's own folder is compared with: the snapshot taken at its start (exact), `HEAD` when the
 *  snapshot failed (earlier edits show too), or nothing for a folder git does not know. */
export function directBase(info: SessionInfo): "snapshot" | "head" | "none" | null {
  const d = info.direct;
  return !d ? null : d.startTree ? "snapshot" : d.headSha ? "head" : "none";
}

/** A terminal session in its own worktree whose program still runs: Approve is "Stop and approve" for it. */
export const runsInWorktree = (info: SessionInfo): boolean =>
  info.interface === "terminal" && !!info.worktree && (info.status === "running" || info.status === "waiting");

/** Which decisions the review bar offers. A session in the user's own folder has no branch to commit to or remove, and
 *  no worktree to discard; Dismiss stays. A running terminal session stops before it is approved. */
export function reviewActions(info: SessionInfo): { approve: boolean; stopAndApprove: boolean; requestChanges: boolean; discard: boolean; dismiss: boolean } {
  const direct = !!info.direct;
  const stop = runsInWorktree(info);
  return { approve: !direct && !stop, stopAndApprove: stop, requestChanges: !direct, discard: !direct, dismiss: true };
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
export function afterDecision(listed: SessionInfo[], done: string): { page: "inbox"; session?: string } {
  const at = listed.findIndex((s) => s.id === done);
  for (let i = 1; i <= listed.length; i++) {
    const next = listed[(at + i + listed.length) % listed.length];
    if (next.id !== done && waitingForReview(next)) return { page: "inbox", session: next.id };
  }
  return { page: "inbox" };
}

/** "3 files", "1 file". */
export const filesWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** Why a session cannot be sent to Codex for review, or null when it can: the review runs on the session's worktree and its
 *  checkpoint, so it needs a session in a worktree of its own, between turns, with edits. */
export function codexBlock(info: SessionInfo): string | null {
  if (!info.worktree) return "Codex reviews the edits of a session that works in its own worktree. This one works in your own folder.";
  if (info.status === "running" || info.status === "waiting") return "Wait for the session to finish its turn first.";
  if ((info.filesChanged?.files ?? 0) === 0) return "This session has no proposed edits to review.";
  return null;
}

/** The Codex review the user asked for on a session, if it is still in the list. */
export const codexReviewer = (info: SessionInfo, all: SessionInfo[]): SessionInfo | undefined =>
  info.reviewedBy ? all.find((s) => s.id === info.reviewedBy) : undefined;

/** "running", "passed", "changes needed" and so on: where a Codex review stands. */
export function codexState(reviewer: SessionInfo): string {
  if (reviewer.status === "running" || reviewer.status === "waiting") return "running";
  if (reviewer.verdict === "pass") return "passed";
  if (reviewer.verdict === "changes_needed") return "changes needed";
  if (reviewer.status === "failed") return "failed";
  if (reviewer.status === "cancelled" || reviewer.status === "ended") return "stopped";
  return "finished, no verdict";
}
