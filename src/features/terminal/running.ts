import { engineName } from "../changes/changes";
import type { SessionInfo } from "../../lib/agent";
import type { TermInfo } from "../../lib/term";
import { isShellId, shellLabel } from "./shells";
import { tabLabel } from "./tabs";

/** One line for each running program, each running chat turn and a running wiki build (its domain and project), for the quit dialog. */
export function runningSummary(terms: TermInfo[], sessions: SessionInfo[], build: { domain: string; project: string } | null = null): string[] {
  const lines: string[] = [];
  for (const t of terms) {
    if (!t.running) continue;
    if (t.sessionId === null && isShellId(t.id)) { lines.push(`${shellLabel(t)} (terminal)`); continue; }
    const s = sessions.find((x) => x.id === t.sessionId);
    lines.push(s ? `${tabLabel(s)} (terminal)` : `${engineName(t.engine === "codex" ? "codex" : "claude-code")} sign-in (terminal)`);
  }
  for (const s of sessions) {
    if (s.interface === "chat" && (s.status === "running" || s.status === "waiting")) lines.push(`Chat turn · ${s.title}`);
  }
  if (build) lines.push(`Wiki build · ${build.domain}${build.project ? ` (${build.project})` : ""}`);
  return lines;
}
