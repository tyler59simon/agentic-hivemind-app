// The maintenance changes the user marked "Looks right" in the Inbox, kept on this computer. A change leaves the Inbox after a
// week anyway, so an id is dropped once the run it came from is older than that.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../../store";
import { pruneSeen } from "./maintenance";

interface SeenState {
  /** An operation id, and the start of the run that made it (ms). */
  seen: Record<string, number>;
  markSeen: (operationId: string, runAt: number) => void;
}

export const useSeen = create<SeenState>()(persist((set) => ({
  seen: {},
  markSeen: (operationId, runAt) => set((s) => ({ seen: { ...pruneSeen(s.seen, Date.now()), [operationId]: runAt } })),
}), {
  name: "hivemind.maintenance.seen",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({ seen: s.seen }),
  merge: (persisted, current) => ({ ...current, seen: pruneSeen((persisted as { seen?: Record<string, number> } | null)?.seen, Date.now()) }),
}));
