import { create } from "zustand";

/** What the connected Living Memory supports (from `version`), so features can degrade gracefully. */
export const useConnection = create<{ commands: string[]; api: number; capabilities?: { learning?: number }; set: (v: { commands: string[]; api: number; capabilities?: { learning?: number } }) => void }>((set) => ({
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
