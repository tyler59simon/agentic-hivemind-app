// What the next agent session starts with. Other pages add notes and a system to it; the Start screen reads it.
// It lives in memory only: the repository, branch, permissions and model are the Start screen's own state.
import { create } from "zustand";

interface SessionDraft {
  task: string;
  /** Note refs, no duplicates, in the order added. */
  context: string[];
  /** Always null until changes exist (Phase 3). */
  change: number | null;
  /** The system whose architecture line goes in the briefing. */
  system: string | null;
  /** A canvas element's name attached with it. */
  element: string | null;
  setTask: (task: string) => void;
  addContext: (ref: string) => void;
  removeContext: (ref: string) => void;
  setSystem: (system: string | null, element?: string | null) => void;
  reset: () => void;
}

const EMPTY = { task: "", context: [], change: null, system: null, element: null };

export const useSessionDraft = create<SessionDraft>()((set) => ({
  ...EMPTY,
  setTask: (task) => set({ task }),
  addContext: (ref) => set((s) => (s.context.includes(ref) ? s : { context: [...s.context, ref] })),
  removeContext: (ref) => set((s) => ({ context: s.context.filter((r) => r !== ref) })),
  setSystem: (system, element = null) => set({ system, element }),
  reset: () => set(EMPTY),
}));
