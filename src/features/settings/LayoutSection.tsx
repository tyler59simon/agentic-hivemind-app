// Settings, Layout (DESK-LAYOUT): the widths of the sidebar, the notes list and the context rail, and whether the sidebar is
// collapsed, as controls that need no dragging (WCAG 2.5.7). Changes apply at once and are kept on this computer. A width
// here is the one saved; a narrow window may draw less (src/shell/budget.ts).
import { useId } from "react";
import { autoRail, LIMITS } from "../../shell/budget";
import { resetLayout, useLayout } from "../../shell/layout";
import { useViewport } from "../../shell/useBudget";

function Width({ label, min, max, value, note, onChange }: { label: string; min: number; max: number; value: number; note?: string; onChange: (rem: number) => void }) {
  const id = useId();
  // One decimal, the precision of the slider step: the value, the readout and the spoken text are the same number.
  const tenths = Math.round(value * 10) / 10;
  const shown = `${tenths} rem`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="layout-width">
        <input id={id} type="range" min={min} max={max} step={0.1} value={tenths} aria-valuetext={shown} onChange={(e) => onChange(Number(e.target.value))} />
        <output htmlFor={id}>{shown}</output>
      </div>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

export function LayoutSection() {
  const layout = useLayout();
  const [viewport, rootPx] = useViewport(); // the rail follows the window until it is set
  return (
    <section className="settings layout" aria-labelledby="layout-title">
      <h2 id="layout-title">Layout</h2>
      <label className="check"><input type="checkbox" checked={layout.sidebarCollapsed} onChange={(e) => layout.setSidebarCollapsed(e.target.checked)} /> Collapse sidebar</label>
      <Width label="Sidebar width" min={LIMITS.sidebar.min} max={LIMITS.sidebar.max} value={layout.sidebarWidth} onChange={layout.setSidebarWidth} />
      <Width label="Notes list width" min={LIMITS.tree.min} max={LIMITS.tree.max} value={layout.treeWidth} onChange={layout.setTreeWidth} />
      <Width label="Rail width when docked" min={LIMITS.rail.min} max={LIMITS.rail.max} value={layout.railWidth ?? autoRail(viewport, rootPx)} onChange={layout.setRailWidth}
        note={layout.railWidth === null ? "Follows the window until you set it." : undefined} />
      <p className="muted small">Sizes are in rem, so they follow the zoom. You can also drag the dividers, or use their arrow keys. A narrow window draws less than the width set here and keeps the notes readable; the set width comes back when there is room. Split panes have a menu on the divider between them (right-click, or Shift+F10).</p>
      <div className="actions">
        <button type="button" onClick={resetLayout}>Reset layout</button>
      </div>
    </section>
  );
}
