// Region sizes and modes (DESK-LAYOUT): the sidebar, the notes tree and the context rail can be dragged to a width, the
// sidebar can be collapsed to its icons, and focus mode hides everything but the open notes. Widths are in rem so they
// follow the window zoom. The store lives in localStorage like `hivemind.workspace`: losing it costs only the widths.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { flushSync } from "react-dom";
import { classify } from "../lib/errors";
import { inTauri } from "../lib/native";
import { safeStorage } from "../store";
import { toast } from "../ui/toast";
import { railShown, useWorkspace } from "../workspace/store";
import { autoRail, clampWidth, DEFAULT_WIDTH, LIMITS } from "./budget";

export { clampWidth, DEFAULT_WIDTH, LIMITS };

/** The rail's width in rem when the user has not set one: the CSS default at the current window width. */
export function autoRailWidth(): number {
  return autoRail(typeof window === "undefined" ? 0 : window.innerWidth, remPx());
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

/** Leave focus mode now, so what the caller does next (focus the search box) finds the regions drawn. */
export function leaveFocusMode(): void {
  if (useLayout.getState().focusMode) flushSync(() => useLayout.getState().setFocusMode(false));
}

/** The rail's button and command. In focus mode the rail is hidden, so asking for it leaves the mode and shows it. */
export function toggleRail(overlay: boolean): void {
  const ws = useWorkspace.getState();
  if (useLayout.getState().focusMode) { leaveFocusMode(); ws.setRail(true, overlay); return; }
  ws.setRail(!railShown(ws, overlay), overlay);
}

/** Every region back to its default size, the sidebar expanded, and the panes equal. */
export function resetLayout(): void {
  useLayout.setState({ sidebarWidth: DEFAULT_WIDTH.sidebar, treeWidth: DEFAULT_WIDTH.tree, railWidth: null, sidebarCollapsed: false });
  useWorkspace.setState((s) => ({ panes: s.panes.map((p) => ({ ...p, size: 1 })) }));
}

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
