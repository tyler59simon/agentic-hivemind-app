// What the Notes page's search box is showing (NS-4A). The box lives in the top bar and the Tags pane is in the notebook
// list, so the query and the filters are kept here for both.
import { create } from "zustand";
import type { PageKind } from "../../lib/noteindex";

export interface SearchFilters {
  /** A notebook id, or "" for every notebook. */
  notebook: string;
  folder: string;
  tag: string;
  kind: PageKind | "";
  /** One of `MODIFIED`'s ids. */
  modified: string;
}

export const NO_FILTERS: SearchFilters = { notebook: "", folder: "", tag: "", kind: "", modified: "any" };

interface SearchState {
  query: string;
  filters: SearchFilters;
  /** Whether results are fused with pages found by meaning (needs the Living Memory model). */
  meaning: boolean;
  /** Whether the results panel is showing. */
  open: boolean;
  /** Bumped when something asks the box to take focus (a tag chosen in the Tags pane). */
  focusTick: number;
  setQuery: (query: string) => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  setMeaning: (meaning: boolean) => void;
  show: () => void;
  close: () => void;
  /** Search for the pages with a tag: opens the panel with that tag as the only filter. */
  byTag: (tag: string) => void;
}

export const useNotesSearch = create<SearchState>((set) => ({
  query: "",
  filters: NO_FILTERS,
  meaning: false,
  open: false,
  focusTick: 0,
  setQuery: (query) => set({ query, open: true }),
  setFilters: (filters) => set((s) => ({ filters: { ...s.filters, ...filters }, open: true })),
  setMeaning: (meaning) => set({ meaning, open: true }),
  show: () => set({ open: true }),
  close: () => set({ open: false }),
  byTag: (tag) => set((s) => ({ query: "", filters: { ...NO_FILTERS, tag }, open: true, focusTick: s.focusTick + 1 })),
}));

/** Whether the filters narrow the search at all. */
export const filtered = (f: SearchFilters) => !!(f.notebook || f.folder || f.tag || f.kind || f.modified !== "any");
