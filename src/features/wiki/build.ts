// The agent-written wiki's build that is running now, kept outside the page so progress survives leaving the Wiki page. One build
// runs at a time (Rust refuses a second). The build's own events drive the progress and the end; the result of the command is a
// fallback for the same end, so the page never stays "building" if an event is lost.
import type { QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { classify } from "../../lib/errors";
import { wikiAgentBuild, wikiAgentCancel, type WikiBuildDone, type WikiBuildEvent } from "../../lib/wiki";
import { toast } from "../../ui/toast";
import { applyProgress, buildOutcome, type BuildProgress } from "./wiki";

interface BuildState {
  /** What is being built: the domain and the project it is limited to ("" for the whole domain). */
  running: { domain: string; project: string } | null;
  progress: BuildProgress | null;
  /** The user asked to stop; the end then reads as cancelled, not failed. */
  cancelling: boolean;
}
export const useWikiBuild = create<BuildState>(() => ({ running: null, progress: null, cancelling: false }));

function finish(client: QueryClient, done: Pick<WikiBuildDone, "ok" | "result" | "error">) {
  const { running, cancelling } = useWikiBuild.getState();
  if (!running) return; // the other of event and result got here first
  useWikiBuild.setState({ running: null, progress: null, cancelling: false });
  const outcome = buildOutcome(done, cancelling);
  toast(outcome.text, outcome.kind);
  client.invalidateQueries({ queryKey: ["wiki-agent"] });
}

let listening: Promise<unknown> | null = null;
const listenOnce = (client: QueryClient) => (listening ??= Promise.all([
  listen<WikiBuildEvent>("wiki-build-progress", (e) => useWikiBuild.setState((s) => (s.running ? { progress: applyProgress(s.progress, e.payload) } : s))),
  listen<WikiBuildDone>("wiki-build-done", (e) => finish(client, e.payload)),
]));

/** Build or refresh the agent-written wiki; resolves when it is over (the toast and refetch have happened by then). */
export async function startWikiBuild(client: QueryClient, domain: string, project: string, restructure: boolean) {
  if (useWikiBuild.getState().running) return;
  useWikiBuild.setState({ running: { domain, project }, progress: null, cancelling: false });
  try {
    await listenOnce(client);
    finish(client, { ok: true, result: await wikiAgentBuild(domain, project || undefined, restructure, false) });
  } catch (e) {
    finish(client, { ok: false, error: classify(e).message });
  }
}

export function cancelWikiBuild() {
  if (!useWikiBuild.getState().running) return;
  useWikiBuild.setState({ cancelling: true });
  wikiAgentCancel().catch((e) => toast(classify(e).message, "error"));
}
