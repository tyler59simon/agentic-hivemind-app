import { create } from "zustand";

export type View = "notes" | "search" | "projects";
export type Shelf = "active" | "archived";

/** Left sidebar and palette state; open notes live in the workspace store (src/workspace/store.ts). */
interface AppState {
  domain: string | null;
  shelf: Shelf;
  view: View;
  palette: "commands" | "notes" | null;
  setDomain: (domain: string) => void;
  setShelf: (shelf: Shelf) => void;
  setView: (view: View) => void;
  setPalette: (palette: AppState["palette"]) => void;
}

export const useApp = create<AppState>((set) => ({
  domain: null,
  shelf: "active",
  view: "notes",
  palette: null,
  setDomain: (domain) => set({ domain }),
  setShelf: (shelf) => set({ shelf }),
  setView: (view) => set({ view }),
  setPalette: (palette) => set({ palette }),
}));
