import { LayoutDashboard } from "lucide-react";
import { viewRef } from "../../lib/lm";
import { useApp } from "../../store";
import { useDashboardToggle } from "./useDashboards";

/** The note page's Dashboard switch: on registers the note as a view, off removes it. When on, it also offers to open it. */
export function DashboardToggle({ refId, title }: { refId: string; title: string }) {
  const { row, on, toggle, pending } = useDashboardToggle(refId, title);
  return (
    <>
      <button className={`text ${on ? "on" : ""}`} aria-pressed={on} disabled={pending} onClick={toggle}
        title={on ? "Stop keeping this note as a dashboard" : "Keep this note as a dashboard that stays current"}>
        <LayoutDashboard size="1.15em" aria-hidden />Dashboard{on ? ": on" : ""}
      </button>
      {row && <button className="text" onClick={() => useApp.getState().go({ page: "dashboards", ref: viewRef(row) })}>Open dashboard</button>}
    </>
  );
}
