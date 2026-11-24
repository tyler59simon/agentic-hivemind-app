// The agent-written wiki's build that is running now, kept outside the view so progress survives leaving Notes > Wiki. One build
// runs at a time (Rust refuses a second). The build's own events drive the progress and the end; the result of the command is a
// fallback for the same end, so the page never stays "building" if an event is lost. A scheduled rebuild (Settings, Schedules) is
// taken up from its first progress event, so the strip, Cancel and the quit summary show it too (WIKI-R1).
import type { QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { automationAct, automationList } from "../../lib/automations";
import { classify } from "../../lib/errors";
import { wikiAgentBuild, wikiAgentCancel, type WikiBuildDone, type WikiBuildEvent } from "../../lib/wiki";
import { toast } from "../../ui/toast";
import { applyProgress, buildOutcome, type BuildProgress } from "./wiki";

const CANCELLED = "Build cancelled.";

interface BuildState {
  /** What is being built: the domain and the project it is limited to ("" for the whole domain). `scheduled`: a weekly rebuild
   *  an automation started, which this view took up from its progress events. */
  running: { domain: string; project: string; scheduled?: true } | null;
  progress: BuildProgress | null;
  /** The user asked to stop; the end then reads as cancelled, not failed. */
  cancelling: boolean;
}
export const useWikiBuild = create<BuildState>(() => ({ running: null, progress: null, cancelling: false }));

/** `foreign`: the done event came with nothing running here, so another build ended (a scheduled rebuild). Its pages are fetched
 *  again with no toast, since the user did not ask for it. */
function finish(client: QueryClient, done: Pick<WikiBuildDone, "ok" | "result" | "error">, foreign = false) {
  const { running, cancelling } = useWikiBuild.getState();
  if (!running) { // the other of event and result got here first, or a build this page did not start ended
    if (foreign) client.invalidateQueries({ queryKey: ["wiki", "agent"] });
    return;
  }
  useWikiBuild.setState({ running: null, progress: null, cancelling: false });
  // A scheduled rebuild ends quietly, as the automation reports it, unless the user cancelled it here.
  if (!running.scheduled || cancelling) {
    const outcome = buildOutcome(done, cancelling);
    toast(outcome.text, outcome.kind);
  }
  client.invalidateQueries({ queryKey: ["wiki", "agent"] });
}

let listening: Promise<unknown> | null = null;
/** Listen for the build's events (once). The wiki view calls this when it opens, so a build it did not start still refreshes it. */
export const listenOnce = (client: QueryClient) => (listening ??= Promise.all([
  listen<WikiBuildEvent>("wiki-build-progress", (e) => useWikiBuild.setState((s) => {
    if (s.running) return { progress: applyProgress(s.progress, e.payload) };
    // A build nobody here started is a scheduled rebuild: take it up, unless this is its last line.
    if (e.payload.event === "end") return s;
    const project = e.payload.scope === "domain" ? "" : e.payload.scope;
    return { running: { domain: e.payload.domain, project, scheduled: true }, progress: applyProgress(null, e.payload), cancelling: false };
  })),
  listen<WikiBuildDone>("wiki-build-done", (e) => finish(client, e.payload, true)),
]));

/** Build or refresh the agent-written wiki; resolves when it is over (the toast and refetch have happened by then). */
export async function startWikiBuild(client: QueryClient, domain: string, project: string, restructure: boolean) {
  if (useWikiBuild.getState().running) return;
  useWikiBuild.setState({ running: { domain, project }, progress: null, cancelling: false });
  try {
    await listenOnce(client);
    // A Cancel pressed while the listeners were being set up found no build in Rust to stop: it is latched in `cancelling`, and the
    // build never starts, so nothing is spent. (A later Cancel is Rust's: it keeps one for a build that has not spawned yet.)
    if (useWikiBuild.getState().cancelling) { finish(client, { ok: false, error: CANCELLED }); return; }
    finish(client, { ok: true, result: await wikiAgentBuild(domain, project || undefined, restructure, false) });
  } catch (e) {
    finish(client, { ok: false, error: classify(e).message });
  }
}

export function cancelWikiBuild() {
  const { running } = useWikiBuild.getState();
  if (!running) return;
  useWikiBuild.setState({ cancelling: true });
  if (running.scheduled) { void cancelScheduled(); return; }
  wikiAgentCancel().catch((e) => toast(classify(e).message, "error"));
}

/** Cancel a scheduled rebuild through its automation run, so the run reads as cancelled rather than failed. Without a running
 *  rebuild run (it ended meanwhile) the build is stopped directly. */
async function cancelScheduled() {
  try {
    const list = await automationList();
    const rebuilds = new Set(list.automations.filter((a) => a.action.kind === "wiki_rebuild").map((a) => a.id));
    const run = list.runs.find((r) => r.state === "running" && rebuilds.has(r.automation));
    if (run) await automationAct("cancel", run.id);
    else await wikiAgentCancel();
  } catch (e) {
    toast(classify(e).message, "error");
  }
}
