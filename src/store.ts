import { create } from "zustand";

export type View = "notes" | "search";
export type Shelf = "active" | "archived";

interface AppState {
  domain: string | null;
  shelf: Shelf;
  view: View;
  selected: string | null; // note ref, domain:id
  palette: "commands" | "notes" | null;
  setDomain: (domain: string) => void;
  setShelf: (shelf: Shelf) => void;
  setView: (view: View) => void;
  open: (ref: string) => void;
  setPalette: (palette: AppState["palette"]) => void;
}

export const useApp = create<AppState>((set) => ({
  domain: null,
  shelf: "active",
  view: "notes",
  selected: null,
  palette: null,
  setDomain: (domain) => set({ domain, selected: null }),
  setShelf: (shelf) => set({ shelf }),
  setView: (view) => set({ view }),
  open: (ref) => set({ selected: ref, palette: null }),
  setPalette: (palette) => set({ palette }),
}));
