import { create } from "zustand";
import type { Capabilities } from "./lm";

/** What the connected Living Memory supports (from `version`), so features can degrade gracefully. */
export const useConnection = create<{ commands: string[]; api: number; capabilities?: Capabilities; set: (v: { commands: string[]; api: number; capabilities?: Capabilities }) => void }>((set) => ({
  commands: [],
  api: 0,
  set: (v) => set(v),
}));

/** Project command centers need an LM that has the `projects` command (API 2+). */
export const useProjectsEnabled = () => useConnection((s) => s.api >= 2 && s.commands.includes("projects"));

/** The systems registry needs an LM that has the `systems` command. */
export const useSystemsEnabled = () => useConnection((s) => s.commands.includes("systems"));

/** Numbered changes need an LM that has the `changes` command. */
export const useChangesEnabled = () => useConnection((s) => s.commands.includes("changes"));

/** The History view needs an LM that has the `log` command. */
export const useLogEnabled = () => useConnection((s) => s.commands.includes("log"));

/** Note dashboards need an LM that has the `views` command. */
export const useViewsEnabled = () => useConnection((s) => s.commands.includes("views"));

/** The domain wiki needs an LM that has the `wiki` command. */
export const useWikiEnabled = () => useConnection((s) => s.commands.includes("wiki"));

/** The `history` capability level: 2 adds `log` summaries, 3 adds summary and actor to `history` rows. */
export const useHistoryLevel = () => useConnection((s) => s.capabilities?.history ?? 0);

/** The Recap page needs history level 2 and the `recap` command. */
export const useRecapEnabled = () => useConnection((s) => (s.capabilities?.history ?? 0) >= 2 && s.commands.includes("recap"));

/** The Maintenance page needs the `maintenance` capability and command. */
export const useMaintenanceEnabled = () => useConnection((s) => (s.capabilities?.maintenance?.version ?? 0) >= 1 && s.commands.includes("maintenance"));

/** Restoring an archived note needs the `restore` capability and command. */
export const useRestoreEnabled = () => useConnection((s) => (s.capabilities?.restore ?? 0) >= 1 && s.commands.includes("restore"));

/** Pinning a note needs the `pin` capability. */
export const usePinEnabled = () => useConnection((s) => (s.capabilities?.pin ?? 0) >= 1);

/** Making a note a rule needs the `rule` capability. */
export const useRuleEnabled = () => useConnection((s) => (s.capabilities?.rule ?? 0) >= 1);

/** Hivemind writes archive, project, system, change and taxonomy edits as direct commands, which an older Living Memory only has as plans. */
export const needsLmUpdate = (v: { capabilities?: Capabilities }) => (v.capabilities?.direct_writes ?? 0) < 1;
