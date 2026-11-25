// The splitters for the sidebar, the notes list and the context rail (DESK-LAYOUT). Each sits on the edge of its region
// (App.css puts it there) and keeps its width in the layout store. The value, the limits and the drag start are what is drawn
// now (budget.ts), not what was saved: a width the window has no room for shows as the width it has, and the saved one comes
// back when there is room. A narrow window folds these regions by its own rules, and then the splitter is hidden.
import { useLayoutEffect } from "react";
import { Splitter } from "../ui/Splitter";
import { DEFAULT_WIDTH, LIMITS } from "./budget";
import { remPx, useLayout } from "./layout";
import { useBudget } from "./useBudget";

const STEP = 1;
const BIG_STEP = 4;
const text = (rem: number) => `${Math.round(rem * 10) / 10} rem`;

export function SidebarSplitter() {
  const set = useLayout((s) => s.setSidebarWidth);
  const b = useBudget();
  const width = Math.max(b.sidebar, LIMITS.sidebar.min);
  return <Splitter label="Sidebar width" controls="app-sidebar" value={width} min={LIMITS.sidebar.min} max={Math.max(b.max.sidebar, width)} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(DEFAULT_WIDTH.sidebar)} />;
}

export function TreeSplitter() {
  const set = useLayout((s) => s.setTreeWidth);
  const b = useBudget();
  const width = Math.max(b.tree, LIMITS.tree.min);
  return <Splitter label="Notes list width" controls="notes-tree" value={width} min={LIMITS.tree.min} max={Math.max(b.max.tree, width)} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(DEFAULT_WIDTH.tree)} />;
}

/** The rail is on the right, so it grows when its edge moves left. Until it is set, its width is the window's (`autoRail`). */
export function RailSplitter() {
  const set = useLayout((s) => s.setRailWidth);
  const b = useBudget();
  const width = Math.max(b.rail, LIMITS.rail.min);
  return <Splitter label="Context rail width" controls="note-rail" reverse value={width} min={LIMITS.rail.min} max={Math.max(b.max.rail, width)} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(null)} />;
}

/** Rendered first in the rail's fragment, so that when the rail goes (the window crosses 1100 px, the zoom changes, the user hides
 *  it) its cleanup runs before the rail leaves the page: focus that is inside the rail or on its divider moves to the rail's
 *  button in the tab strip, or to the page, instead of falling to the top of the document. */
export function RailFocusGuard() {
  useLayoutEffect(() => () => {
    if (!document.activeElement?.closest(".note-rail, .notes-area > .splitter")) return;
    (document.querySelector<HTMLElement>("button[aria-label='Context rail']") ?? document.querySelector<HTMLElement>("main.page-host"))?.focus();
  }, []);
  return null;
}
