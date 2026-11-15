import type { SessionInfo } from "../../lib/agent";

/** What an agent tab shows: the real terminal, or the conversation read from the CLI's own file. */
export type View = "terminal" | "transcript";

/** How often the transcript is read again while the session runs and the transcript is shown. */
export const TRANSCRIPT_POLL_MS = 3000;

const DONE: SessionInfo["status"][] = ["ended", "failed", "succeeded", "cancelled"];

/** The user's choice for this tab, else Transcript for a session that is over and Terminal for one that is starting or running. */
export function viewOf(chosen: View | undefined, session: Pick<SessionInfo, "status">, running: boolean): View {
  return chosen ?? (!running && DONE.includes(session.status) ? "transcript" : "terminal");
}

/** The `refetchInterval` of the transcript query. */
export const pollMs = (view: View, running: boolean): number | false => (view === "transcript" && running ? TRANSCRIPT_POLL_MS : false);

/** How an agent tab starts its program the first time it shows: a resume for an imported conversation, else a fresh start. */
export const startModeOf = (session: Pick<SessionInfo, "status" | "engineSession">): "fresh" | "resume" | null =>
  session.status !== "idle" ? null : session.engineSession ? "resume" : "fresh";
