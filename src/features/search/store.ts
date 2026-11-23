// What the unified top-bar search box is showing (NS-4A, CON-11). The box lives in the top bar on every page;
// the Notes Tags pane and Command Palette can open it with a pre-filled filter.
import { create } from "zustand";
import type { PageKind } from "../../lib/noteindex";
import type { MemoryStatus } from "./memory";

export interface SearchFilters {
  /** Memory note status filter: active, archived (archived/resolved/superseded), or any. */
  status: MemoryStatus;
  /** A memory note type (decision, bug, plan...), or "" for any type. */
  noteType: string;
  /** When a project is picked, true searches Memory notes across all projects instead of only the picked one. */
  allProjects: boolean;
  /** A folder notebook id, or "" for every notebook. */
  notebook: string;
  folder: string;
  tag: string;
  kind: PageKind | "";
  /** One of `MODIFIED`'s ids. */
  modified: string;
}

export const NO_FILTERS: SearchFilters = {
  status: "active",
  noteType: "",
  allProjects: false,
  notebook: "",
  folder: "",
  tag: "",
  kind: "",
  modified: "any",
};

interface SearchState {
  query: string;
  filters: SearchFilters;
  /** Whether folder notebook results are fused with pages found by meaning (needs the Living Memory model). */
  meaning: boolean;
  /** Whether the results panel is showing. */
  open: boolean;
  /** Bumped when something asks the box to take focus (a tag chosen in the Tags pane, Ctrl+K, Command Palette). */
  focusTick: number;
  setQuery: (query: string) => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  setMeaning: (meaning: boolean) => void;
  show: () => void;
  close: () => void;
  /** Open the panel and focus the search input. */
  focus: () => void;
  /** Search for pages and memory notes carrying a tag. */
  byTag: (tag: string) => void;
  /** Open the panel filtered to a memory status (active, archived, any). */
  byStatus: (status: MemoryStatus) => void;
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
  focus: () => set((s) => ({ open: true, focusTick: s.focusTick + 1 })),
  byTag: (tag) => set((s) => ({ query: "", filters: { ...NO_FILTERS, tag }, open: true, focusTick: s.focusTick + 1 })),
  byStatus: (status) => set((s) => ({ query: "", filters: { ...NO_FILTERS, status }, open: true, focusTick: s.focusTick + 1 })),
}));

/** Filters that apply only to folder notebook pages. */
export const pageOnlyFiltered = (f: SearchFilters) => !!(f.notebook || f.folder || f.kind || f.modified !== "any");

/** Filters that apply only to Living Memory notes. */
export const memoryOnlyFiltered = (f: SearchFilters) => f.status !== "active" || !!f.noteType;

/** Whether any filter differs from the default. */
export const filtered = (f: SearchFilters) => pageOnlyFiltered(f) || memoryOnlyFiltered(f) || !!f.tag || f.allProjects;
