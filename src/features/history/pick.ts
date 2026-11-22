// The version a row of the page rail asked the History view to show (NS-5). The rail and the view are separate
// components, so the request waits here, by tab, until the view has the timeline and takes it.
import { create } from "zustand";

interface Picks {
  picks: Record<string, string>;
  /** Ask for the version `id` (a timeline row's id) in the tab `tabId`. */
  pick: (tabId: string, id: string) => void;
  clear: (tabId: string) => void;
}

export const usePick = create<Picks>()((set) => ({
  picks: {},
  pick: (tabId, id) => set((s) => ({ picks: { ...s.picks, [tabId]: id } })),
  clear: (tabId) => set((s) => { const { [tabId]: _, ...rest } = s.picks; return { picks: rest }; }),
}));
