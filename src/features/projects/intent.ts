// Cross-component requests for the projects UI: open the create wizard, or expand Triage once after a project is made.
import { create } from "zustand";

interface ProjectIntent {
  wizard: boolean;
  triage: string[]; // slugs whose dashboard should open with Triage expanded (consumed once)
  openWizard: () => void;
  closeWizard: () => void;
  requestTriage: (slug: string) => void;
  /** True once per request: the dashboard calls this on mount. */
  takeTriage: (slug: string) => boolean;
}

export const useProjectIntent = create<ProjectIntent>((set, get) => ({
  wizard: false,
  triage: [],
  openWizard: () => set({ wizard: true }),
  closeWizard: () => set({ wizard: false }),
  requestTriage: (slug) => set((s) => ({ triage: [...new Set([...s.triage, slug])] })),
  takeTriage: (slug) => {
    if (!get().triage.includes(slug)) return false;
    set((s) => ({ triage: s.triage.filter((t) => t !== slug) }));
    return true;
  },
}));
