import { invoke } from "@tauri-apps/api/core";
import { useConnection } from "./connection";
import type { Capabilities } from "./lm";
import { currentTheme, type Theme } from "./theme";

/** The theme an exported page starts in, or null when the connected Living Memory would reject `--theme`: the flag ships with
 *  the `wiki_agent` capability, so an older install gets the page without it (and it follows the system theme as before). */
export const exportTheme = (capabilities: Capabilities | undefined, theme: Theme): Theme | null => ((capabilities?.wiki_agent?.version ?? 0) >= 1 ? theme : null);

/** Save a domain's wiki as one HTML file: Rust asks where with a native dialog, has Living Memory write it, and opens it.
 *  `agent` exports the agent-written edition (of `project` when given). The file starts in the app's current theme where Living
 *  Memory supports that. Resolves with the saved path, or null when the dialog was cancelled. */
export const exportWiki = (domain: string, archived: boolean, o: { agent?: boolean; project?: string } = {}) =>
  invoke<string | null>("wiki_export", { domain, archived, agent: !!o.agent, project: o.project ?? null, theme: exportTheme(useConnection.getState().capabilities, currentTheme()) });

/** What a dry run of `wiki --agent --build` reports: the calls it would make and the budget cap; it spends nothing.
 *  `calls.pages` is null on a first build, before the outline call has planned the pages. */
export interface WikiBuildPlan {
  ok: true; dry_run: true; domain: string; scope: string; model: string; notes: number;
  calls: { outline: number; place: number; pages: number | null };
  packet_chars: { outline: number; place: number; page_max: number };
  budget_usd: number;
}
/** What a finished build reports. `stopped` says why it ended early: the budget ran out, or an error. */
export interface WikiBuildResult {
  ok: true; dry_run?: false; domain: string; scope: string; model: string;
  calls: { outline: number; place: number; pages: number };
  written: string[]; failed: { page: string; reason: string }[]; pending: string[];
  stopped: null | "budget" | "error"; cost_usd: number; budget_usd: number; path: string;
}

/** One line of a build's progress (`wiki-build-progress`), tagged with the domain and scope it belongs to. */
export type WikiBuildEvent = { domain: string; scope: string } & (
  | { event: "start"; calls: number | null }
  | { event: "call"; kind: "outline" | "place" | "page"; page: string | null; title: string | null; ok: boolean; done: number; total: number | null; cost_usd: number }
  | { event: "end"; ok: boolean; stopped: null | "budget" | "error"; cost_usd: number }
);
/** `wiki-build-done`: the build is over, with its result or the reason it failed (or was cancelled). */
export interface WikiBuildDone { domain: string; scope: string; ok: boolean; result?: WikiBuildResult; error?: string }

/** Build or refresh the agent-written wiki. A dry run returns the plan; a real build returns when it is over, and reports
 *  `wiki-build-progress` and `wiki-build-done` events meanwhile. One build runs at a time. */
export function wikiAgentBuild(domain: string, project: string | undefined, restructure: boolean, dryRun: true): Promise<WikiBuildPlan>;
export function wikiAgentBuild(domain: string, project: string | undefined, restructure: boolean, dryRun: false): Promise<WikiBuildResult>;
export function wikiAgentBuild(domain: string, project: string | undefined, restructure: boolean, dryRun: boolean) {
  return invoke("wiki_agent_build", { domain, project: project ?? null, restructure, dryRun });
}
/** Stop the running build. The pages it already wrote are kept. */
export const wikiAgentCancel = () => invoke<void>("wiki_agent_cancel");
