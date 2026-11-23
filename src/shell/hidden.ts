// Sidebar sections the user hid on this computer (Settings > Sidebar, or right-click a section). A hidden section leaves the
// sidebar and the palette's go-to entry; links and the current route still open it. Home is always shown.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage, type Page } from "../store";

interface HiddenState {
  hidden: Page[];
  setShown: (page: Page, shown: boolean) => void;
}

/** Version 2: the Architecture and Changes sections were removed (CON-4, CON-17), so a saved hide of either is dropped.
 *  Version 3: the Review section became the Inbox (CON-6), so a saved hide of Review hides the Inbox. */
export function migrateHidden(persisted: unknown): unknown {
  const saved = persisted as { hidden?: string[] } | null;
  if (!Array.isArray(saved?.hidden)) return persisted;
  const kept = saved.hidden.filter((p) => p !== "architecture" && p !== "changes").map((p) => (p === "review" ? "inbox" : p));
  return { ...saved, hidden: kept.filter((p, i) => kept.indexOf(p) === i) };
}

export const useHidden = create<HiddenState>()(persist((set) => ({
  hidden: [],
  setShown: (page, shown) => {
    if (page === "home") return;
    set((s) => ({ hidden: shown ? s.hidden.filter((p) => p !== page) : s.hidden.includes(page) ? s.hidden : [...s.hidden, page] }));
  },
}), {
  name: "hivemind.sidebar",
  version: 3,
  storage: createJSONStorage(() => safeStorage),
  migrate: (persisted, version) => (version < 3 ? migrateHidden(persisted) : persisted) as HiddenState,
  partialize: (s) => ({ hidden: s.hidden }),
}));
