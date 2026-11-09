import type { ReactNode } from "react";
import { Outline } from "../features/outline/Outline";
import { activeTab, useWorkspace, type Panel, type Tab } from "./store";

/** Panels about the focused note. Each is registered here as its phase lands. */
export const PANELS: { id: Panel; label: string; render: (tab: Tab) => ReactNode }[] = [
  { id: "outline", label: "Outline", render: (tab) => <Outline tab={tab} /> },
];

export function RightSidebar() {
  const panel = useWorkspace((s) => s.panel);
  const setPanel = useWorkspace((s) => s.setPanel);
  const tab = useWorkspace(activeTab);
  const current = PANELS.find((p) => p.id === panel) ?? PANELS[0];
  return (
    <aside className="right-sidebar">
      <div className="segmented small-tabs" role="tablist">
        {PANELS.map((p) => (
          <button key={p.id} role="tab" aria-selected={current.id === p.id} className={current.id === p.id ? "on" : ""} onClick={() => setPanel(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab?.kind === "note" && tab.ref ? current.render(tab) : <p className="muted pad">Open a note to see its {current.label.toLowerCase()}.</p>}
      </div>
    </aside>
  );
}
