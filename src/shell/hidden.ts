// Sidebar sections the user hid on this computer (Settings > Sidebar, or right-click a section). A hidden section leaves the
// sidebar and the palette's go-to entry; links and the current route still open it. Home is always shown.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage, type Page } from "../store";

interface HiddenState {
  hidden: Page[];
  setShown: (page: Page, shown: boolean) => void;
}

const REMOVED_SECTIONS = new Set(["architecture", "changes", "overview", "executive", "recap", "memory", "dashboards", "wiki", "workflows", "maintenance", "skills"]);

/** Version 2: Architecture and Changes removed (CON-4, CON-17). Version 3: Review became Inbox (CON-6).
 *  Version 4: Memory retired (CON-21) and remaining removed sections (overview, executive, recap) dropped (CONR-7).
 *  Version 5: Dashboards became Notes > Views (CON-13). Version 6: the Wiki became Notes > Wiki (CON-14).
 *  Version 7: Workflows removed; its schedules are in Settings (CON-20). Version 8: Maintenance moved to Settings and Skills to
 *  Notes > Skills (CON-22). */
export function migrateHidden(persisted: unknown): unknown {
  const saved = persisted as { hidden?: string[] } | null;
  if (!Array.isArray(saved?.hidden)) return persisted;
  const kept = saved.hidden.filter((p) => !REMOVED_SECTIONS.has(p)).map((p) => (p === "review" ? "inbox" : p));
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
  version: 8,
  storage: createJSONStorage(() => safeStorage),
  migrate: (persisted, version) => (version < 8 ? migrateHidden(persisted) : persisted) as HiddenState,
  partialize: (s) => ({ hidden: s.hidden }),
}));
