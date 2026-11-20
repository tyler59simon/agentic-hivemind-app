// Sidebar sections the user hid on this computer (Settings > Sidebar, or right-click a section). A hidden section leaves the
// sidebar and the palette's go-to entry; links and the current route still open it. Overview is always shown.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage, type Page } from "../store";

interface HiddenState {
  hidden: Page[];
  setShown: (page: Page, shown: boolean) => void;
}

export const useHidden = create<HiddenState>()(persist((set) => ({
  hidden: [],
  setShown: (page, shown) => {
    if (page === "overview") return;
    set((s) => ({ hidden: shown ? s.hidden.filter((p) => p !== page) : s.hidden.includes(page) ? s.hidden : [...s.hidden, page] }));
  },
}), {
  name: "hivemind.sidebar",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({ hidden: s.hidden }),
}));
