// The splitters for the sidebar, the notes tree and the context rail (DESK-LAYOUT). Each sits on the edge of its region
// (App.css puts it there) and keeps its width in the layout store. A narrow window folds these regions by its own rules, and
// then the splitter is hidden.
import { Splitter } from "../ui/Splitter";
import { autoRailWidth, DEFAULT_WIDTH, LIMITS, remPx, useLayout } from "./layout";

const STEP = 1;
const BIG_STEP = 4;
const text = (rem: number) => `${Math.round(rem * 10) / 10} rem`;

export function SidebarSplitter() {
  const width = useLayout((s) => s.sidebarWidth);
  const set = useLayout((s) => s.setSidebarWidth);
  return <Splitter label="Sidebar width" value={width} min={LIMITS.sidebar.min} max={LIMITS.sidebar.max} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(DEFAULT_WIDTH.sidebar)} />;
}

export function TreeSplitter() {
  const width = useLayout((s) => s.treeWidth);
  const set = useLayout((s) => s.setTreeWidth);
  return <Splitter label="Notes list width" value={width} min={LIMITS.tree.min} max={LIMITS.tree.max} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(DEFAULT_WIDTH.tree)} />;
}

/** The rail is on the right, so it grows when its edge moves left. Until it is set, its width is the window's (`autoRailWidth`). */
export function RailSplitter() {
  const stored = useLayout((s) => s.railWidth);
  const set = useLayout((s) => s.setRailWidth);
  const width = stored ?? autoRailWidth();
  return <Splitter label="Context rail width" reverse value={width} min={LIMITS.rail.min} max={LIMITS.rail.max} step={STEP} bigStep={BIG_STEP} pxPerUnit={remPx()}
    text={text(width)} onChange={set} onReset={() => set(null)} />;
}
