// The width budget (budget.ts) for this window as it is now: the saved widths, the open panes, whether the rail is open, and the
// window's size, which it follows (a resize, and the zoom, which changes the window's width in CSS px).
import { useMemo, useSyncExternalStore } from "react";
import { useApp } from "../store";
import { hasTabs, railShown, useWorkspace } from "../workspace/store";
import { effectiveLayout, type Budget } from "./budget";
import { remPx, useLayout } from "./layout";

const subscribe = (listener: () => void) => { window.addEventListener("resize", listener); return () => window.removeEventListener("resize", listener); };
/** The window width and the rem in one string, so the snapshot is stable between changes. */
const snapshot = () => `${window.innerWidth}:${remPx()}`;

/** The window width in CSS px and the size of 1 rem in CSS px, kept current. */
export function useViewport(): [number, number] {
  const [viewport, rootPx] = useSyncExternalStore(subscribe, snapshot).split(":").map(Number);
  return [viewport, rootPx];
}

export function useBudget(): Budget {
  const [viewport, rootPx] = useViewport();
  const layout = useLayout();
  const notes = useApp((s) => s.route.page === "notes");
  const lists = useApp((s) => s.route.page === "notes" && !!s.route.view);
  const panes = useWorkspace((s) => s.panes.length);
  const open = useWorkspace(hasTabs);
  // Whether the rail is open beside the note (wide window), the way the user left it.
  const railOpen = useWorkspace((s) => railShown(s, false));
  return useMemo(() => effectiveLayout({
    viewport, rootPx, sidebar: layout.sidebarWidth, tree: layout.treeWidth, rail: layout.railWidth, collapsed: layout.sidebarCollapsed, focus: layout.focusMode,
    treeShown: notes, railOpen: notes && open && !lists && railOpen, panes,
  }), [viewport, rootPx, layout.sidebarWidth, layout.treeWidth, layout.railWidth, layout.sidebarCollapsed, layout.focusMode, notes, open, lists, railOpen, panes]);
}
