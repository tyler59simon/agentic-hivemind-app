// Settings, Layout (DESK-LAYOUT): the widths of the sidebar, the notes list and the context rail, and whether the sidebar is
// collapsed, as controls that need no dragging (WCAG 2.5.7). Changes apply at once and are kept on this computer. A width
// here is the one saved; a narrow window may draw less (src/shell/budget.ts).
import { useId } from "react";
import { LIMITS } from "../../shell/budget";
import { autoRailWidth, resetLayout, useLayout } from "../../shell/layout";

function Width({ label, min, max, value, note, onChange }: { label: string; min: number; max: number; value: number; note?: string; onChange: (rem: number) => void }) {
  const id = useId();
  const shown = `${Math.round(value * 10) / 10} rem`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="layout-width">
        <input id={id} type="range" min={min} max={max} step={1} value={value} aria-valuetext={shown} onChange={(e) => onChange(Number(e.target.value))} />
        <output htmlFor={id}>{shown}</output>
      </div>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

export function LayoutSection() {
  const layout = useLayout();
  return (
    <section className="settings layout" aria-labelledby="layout-title">
      <h3 id="layout-title">Layout</h3>
      <label className="check"><input type="checkbox" checked={layout.sidebarCollapsed} onChange={(e) => layout.setSidebarCollapsed(e.target.checked)} /> Collapse sidebar</label>
      <Width label="Sidebar width" min={LIMITS.sidebar.min} max={LIMITS.sidebar.max} value={layout.sidebarWidth} onChange={layout.setSidebarWidth} />
      <Width label="Notes list width" min={LIMITS.tree.min} max={LIMITS.tree.max} value={layout.treeWidth} onChange={layout.setTreeWidth} />
      <Width label="Context rail width" min={LIMITS.rail.min} max={LIMITS.rail.max} value={layout.railWidth ?? autoRailWidth()} onChange={layout.setRailWidth}
        note={layout.railWidth === null ? "Follows the window until you set it." : undefined} />
      <p className="muted small">Sizes are in rem, so they follow the zoom. You can also drag the dividers, or use their arrow keys. A narrow window draws less than the width set here and keeps the notes readable; the set width comes back when there is room. Split panes have a menu on the divider between them (right-click, or Shift+F10).</p>
      <div className="actions">
        <button type="button" onClick={resetLayout}>Reset layout</button>
      </div>
    </section>
  );
}
