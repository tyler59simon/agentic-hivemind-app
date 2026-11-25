// Region sizes and modes (DESK-LAYOUT): the sidebar, the notes tree and the context rail can be dragged to a width, the
// sidebar can be collapsed to its icons, and focus mode hides everything but the open notes. Widths are in rem so they
// follow the window zoom. The store lives in localStorage like `hivemind.workspace`: losing it costs only the widths.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { classify } from "../lib/errors";
import { inTauri } from "../lib/native";
import { safeStorage } from "../store";
import { toast } from "../ui/toast";

/** The width limits of each region in rem. */
export const LIMITS = {
  sidebar: { min: 12, max: 24 },
  tree: { min: 12, max: 28 },
  rail: { min: 15, max: 32 },
} as const;

/** The width a region has until the user drags it, in rem: what App.css had before. The rail has none: it follows the window,
 *  `clamp(15rem, 24vw, 25rem)` (see `autoRailWidth`). */
export const DEFAULT_WIDTH = { sidebar: 15.4, tree: 16 } as const;

type Region = keyof typeof LIMITS;

/** `value` held between the limits of `region`; anything that is not a finite number gives `fallback`. */
export function clampWidth(region: Region, value: unknown, fallback: number = LIMITS[region].min): number {
  const { min, max } = LIMITS[region];
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** The rail's width in rem when the user has not set one: the CSS default at the current window width. */
export function autoRailWidth(): number {
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  return Math.min(25, Math.max(15, (0.24 * vw) / remPx()));
}

/** The size of 1rem in CSS pixels. */
export function remPx(): number {
  const size = typeof document === "undefined" ? NaN : parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  treeWidth: number;
  /** null: the width follows the window until the user drags the rail. */
  railWidth: number | null;
  /** Not kept over a restart: the app should not open with its regions hidden. */
  focusMode: boolean;
  setSidebarWidth: (rem: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTreeWidth: (rem: number) => void;
  setRailWidth: (rem: number | null) => void;
  setFocusMode: (on: boolean) => void;
}

/** What the store keeps, with every width held to its limits and every flag a boolean (a bad stored value is repaired). */
export function sanitize(stored: unknown): Partial<LayoutState> {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    sidebarWidth: clampWidth("sidebar", s.sidebarWidth, DEFAULT_WIDTH.sidebar),
    sidebarCollapsed: s.sidebarCollapsed === true,
    treeWidth: clampWidth("tree", s.treeWidth, DEFAULT_WIDTH.tree),
    railWidth: s.railWidth == null ? null : clampWidth("rail", s.railWidth),
  };
}

export const useLayout = create<LayoutState>()(persist((set) => ({
  sidebarWidth: DEFAULT_WIDTH.sidebar,
  sidebarCollapsed: false,
  treeWidth: DEFAULT_WIDTH.tree,
  railWidth: null,
  focusMode: false,
  setSidebarWidth: (rem) => set({ sidebarWidth: clampWidth("sidebar", rem, DEFAULT_WIDTH.sidebar) }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setTreeWidth: (rem) => set({ treeWidth: clampWidth("tree", rem, DEFAULT_WIDTH.tree) }),
  setRailWidth: (rem) => set({ railWidth: rem === null ? null : clampWidth("rail", rem) }),
  setFocusMode: (focusMode) => set({ focusMode }),
}), {
  name: "hivemind.layout",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s) => ({ sidebarWidth: s.sidebarWidth, sidebarCollapsed: s.sidebarCollapsed, treeWidth: s.treeWidth, railWidth: s.railWidth }),
  merge: (stored, current) => ({ ...current, ...sanitize(stored) }),
}));

export const toggleSidebar = () => useLayout.getState().setSidebarCollapsed(!useLayout.getState().sidebarCollapsed);
export const toggleFocusMode = () => useLayout.getState().setFocusMode(!useLayout.getState().focusMode);

/** Full screen on or off for the window this runs in. Outside the app there is no window to change. */
export async function toggleFullscreen(): Promise<void> {
  if (!inTauri()) return;
  try {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  } catch (e) {
    toast(classify(e).message, "error");
  }
}
