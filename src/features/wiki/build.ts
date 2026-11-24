// The agent-written wiki's build that is running now, kept outside the view so progress survives leaving Notes > Wiki. One build
// runs at a time (Rust refuses a second). The build's own events drive the progress and the end; the result of the command is a
// fallback for the same end, so the page never stays "building" if an event is lost. A scheduled rebuild (Settings, Schedules) is
// taken up from its first progress event, so the strip, Cancel and the quit summary show it too (WIKI-R1).
import type { QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { automationAct, automationList } from "../../lib/automations";
import { classify } from "../../lib/errors";
import { wikiAgentBuild, wikiAgentCancel, wikiAgentRunning, type WikiBuildDone, type WikiBuildEvent } from "../../lib/wiki";
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
/** Listen for the build's events (once). The app calls this at start, so a scheduled rebuild shows in the quit summary before the
 *  wiki was ever opened (Codex review of 99ceaea, W2); the wiki view calls it too. */
export const listenOnce = (client: QueryClient) => (listening ??= Promise.all([
  listen<WikiBuildEvent>("wiki-build-progress", (e) => useWikiBuild.setState((s) => {
    if (s.running) return { progress: applyProgress(s.progress, e.payload) };
    // A build nobody here started is a scheduled rebuild: take it up, unless this is its last line.
    if (e.payload.event === "end") return s;
    return { running: { domain: e.payload.domain, project: projectOf(e.payload.scope), scheduled: true }, progress: applyProgress(null, e.payload), cancelling: false };
  })),
  listen<WikiBuildDone>("wiki-build-done", (e) => finish(client, e.payload, true)),
  // A scheduled rebuild has no command result to fall back on: when its automation run is over and the done event was lost,
  // the build ends here instead of showing forever (W2).
  listen("automations-changed", () => { void settleScheduled(client); }),
]).then((stops) => { void adoptRunning(); return stops; }));

/** Where a build's scope names its project: "domain" is the whole domain (""). */
const projectOf = (scope: string) => (scope === "domain" ? "" : scope);

/** Rust's own view of the running build, for a rebuild that started before the listeners did (Codex re-review of 55cfab2). */
async function adoptRunning() {
  const native = await wikiAgentRunning().catch(() => null);
  if (!native || useWikiBuild.getState().running) return;
  useWikiBuild.setState({ running: { domain: native.domain, project: projectOf(native.scope), scheduled: true }, progress: null, cancelling: false });
}

/** Whether Rust still runs the build shown here. Unknown (the call failed) counts as yes. */
async function stillRunning(running: { domain: string; project: string }) {
  const native = await wikiAgentRunning().catch(() => "unknown" as const);
  return native === "unknown" || (!!native && native.domain === running.domain && projectOf(native.scope) === running.project);
}

/** The running automation run of the scheduled rebuild shown here, if any. */
async function scheduledRun(running: { domain: string; project: string }) {
  const list = await automationList();
  const mine = new Set(list.automations
    .filter((a) => a.action.kind === "wiki_rebuild" && a.action.domain === running.domain && (a.project ?? "") === running.project)
    .map((a) => a.id));
  return list.runs.find((r) => r.state === "running" && mine.has(r.automation));
}

/** A scheduled rebuild ends here when Rust no longer runs it, whatever its automation definition says now (the user may have
 *  edited it meanwhile; Codex re-review of 55cfab2). */
async function settleScheduled(client: QueryClient) {
  const { running } = useWikiBuild.getState();
  if (!running?.scheduled) return;
  if (await stillRunning(running) || useWikiBuild.getState().running !== running) return;
  finish(client, { ok: false, error: CANCELLED }, true);
}

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
  // A cancel that did not reach the build leaves Cancel usable, and the end then reads as it is (Codex review of 99ceaea, W3).
  const failed = (e: unknown) => {
    if (useWikiBuild.getState().running === running) useWikiBuild.setState({ cancelling: false });
    toast(classify(e).message, "error");
  };
  if (running.scheduled) { void cancelScheduled(running).catch(failed); return; }
  wikiAgentCancel().catch(failed);
}

/** Cancel a scheduled rebuild through its own automation run (the one rebuilding this domain and project), so the run reads as
 *  cancelled rather than failed. With no such run left the rebuild has ended, and nothing is stopped: a build started since is
 *  someone else's (Codex review of 99ceaea, W1). */
async function cancelScheduled(running: { domain: string; project: string }) {
  const run = await scheduledRun(running);
  if (run) { await automationAct("cancel", run.id); return; }
  // No run matches (its definition was edited meanwhile, or it ended): stop the build only when Rust still runs this one.
  const native = await wikiAgentRunning();
  if (native && native.domain === running.domain && projectOf(native.scope) === running.project) { await wikiAgentCancel(); return; }
  throw new Error("The scheduled rebuild has already ended.");
}
