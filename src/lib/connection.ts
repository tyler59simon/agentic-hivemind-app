import { create } from "zustand";

/** What the connected Living Memory supports (from `version`), so features can degrade gracefully. */
export const useConnection = create<{ commands: string[]; api: number; set: (v: { commands: string[]; api: number }) => void }>((set) => ({
  commands: [],
  api: 0,
  set: (v) => set(v),
}));
