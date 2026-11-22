// Sidebar sections the user hid on this computer (Settings > Sidebar, or right-click a section). A hidden section leaves the
// sidebar and the palette's go-to entry; links and the current route still open it. Home is always shown.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage, type Page } from "../store";

interface HiddenState {
  hidden: Page[];
  setShown: (page: Page, shown: boolean) => void;
}

/** Version 2: the Architecture and Changes sections were removed (CON-4, CON-17), so a saved hide of either is dropped. */
export function migrateHidden(persisted: unknown): unknown {
  const saved = persisted as { hidden?: string[] } | null;
  if (!Array.isArray(saved?.hidden)) return persisted;
  return { ...saved, hidden: saved.hidden.filter((p) => p !== "architecture" && p !== "changes") };
}

export const useHidden = create<HiddenState>()(persist((set) => ({
  hidden: [],
  setShown: (page, shown) => {
    if (page === "home") return;
    set((s) => ({ hidden: shown ? s.hidden.filter((p) => p !== page) : s.hidden.includes(page) ? s.hidden : [...s.hidden, page] }));
  },
}), {
  name: "hivemind.sidebar",
  version: 2,
  storage: createJSONStorage(() => safeStorage),
  migrate: (persisted, version) => (version < 2 ? migrateHidden(persisted) : persisted) as HiddenState,
  partialize: (s) => ({ hidden: s.hidden }),
}));
