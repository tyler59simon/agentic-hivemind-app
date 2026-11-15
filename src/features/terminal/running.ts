import { engineName } from "../changes/changes";
import type { SessionInfo } from "../../lib/agent";
import type { TermInfo } from "../../lib/term";
import { defaultLabel } from "./tabs";

/** One line for each running program and each running chat turn, for the quit dialog. */
export function runningSummary(terms: TermInfo[], sessions: SessionInfo[]): string[] {
  const lines: string[] = [];
  for (const t of terms) {
    if (!t.running) continue;
    const s = sessions.find((x) => x.id === t.sessionId);
    lines.push(s ? `${defaultLabel(s)} (terminal)` : `${engineName(t.engine === "codex" ? "codex" : "claude-code")} sign-in (terminal)`);
  }
  for (const s of sessions) {
    if (s.interface === "chat" && (s.status === "running" || s.status === "waiting")) lines.push(`Chat turn · ${s.title}`);
  }
  return lines;
}
