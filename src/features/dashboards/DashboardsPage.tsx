import { LayoutDashboard } from "lucide-react";
import { useViewsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { viewRef, type ViewRow } from "../../lib/lm";
import { useApp } from "../../store";
import { PageHeader } from "../../ui/Page";
import { DashboardView } from "./DashboardView";
import { useViewModels, useViews } from "./useDashboards";

/** The registered views, in the order LM returns them (by domain, then note). */
function List({ rows, current }: { rows: ViewRow[]; current?: ViewRow }) {
  const go = useApp((s) => s.go);
  const models = useViewModels(rows);
  return (
    <ol className="lib-list">
      {rows.map((r, i) => {
        const ref = viewRef(r);
        const selected = !!current && viewRef(current) === ref;
        const counts = models[i]?.data?.counts;
        return (
          <li key={ref}>
            <button className={"lib-row dash-row" + (selected ? " on" : "")} aria-current={selected} onClick={() => go({ page: "dashboards", ref }, { replace: true })}>
              <LayoutDashboard size="1.3em" aria-hidden />
              <span className="lib-row-main">
                <span className="lib-row-title">{r.title || r.note_title || r.note.slice(0, 8)}</span>
                <span className="lib-row-meta">
                  <span>{r.note_title ?? "Note not found"}</span>
                  {counts && <span>{counts.open} open of {counts.total}</span>}
                </span>
                <span className="dash-chips">
                  {r.note_title === null && <span className="status-chip bad">note missing</span>}
                  <span className={`status-chip ${r.fresh ? "ok" : "warn"}`} title={r.fresh ? "The page shows the note's current revision" : "The page is older than the note and will be rewritten"}>{r.fresh ? "fresh" : "stale"}</span>
                  {r.artifact_url && <span className={`status-chip ${r.artifact_current ? "next" : "warn"}`} title={r.artifact_current ? "The published artifact shows the current revision" : "The published artifact is behind the note"}>artifact{r.artifact_current ? "" : " behind"}</span>}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Dashboards: notes kept as live dashboards by Living Memory, drawn natively. A dashboard is added from a note's page. */
export function DashboardsPage() {
  const enabled = useViewsEnabled();
  const { query, rows } = useViews();
  const picked = useApp((s) => (s.route.page === "dashboards" ? s.route.ref : undefined));
  const current = rows.find((r) => viewRef(r) === picked) ?? rows[0];
  if (!enabled) {
    return (
      <div className="page">
        <PageHeader title="Dashboards" subtitle="Notes kept as live dashboards." />
        <p className="muted">This version of Living Memory has no <code>views</code> command. Update Living Memory to use dashboards.</p>
      </div>
    );
  }
  if (current) return <div className="page"><DashboardView row={current} list={<List rows={rows} current={current} />} /></div>;
  return (
    <div className="page">
      <PageHeader title="Dashboards" subtitle="Notes kept as live dashboards." />
      {query.isLoading ? <p className="muted">Loading…</p> : query.error ? <p className="error">{classify(query.error).message}</p> : (
        <div className="empty-state">
          <strong>No dashboards yet</strong>
          <p className="muted">A dashboard shows one note, usually a plan, bug or risk with action items, as a page that stays current. Add one from a note's page with the Dashboard button, or run <code>views add REF</code>.</p>
        </div>
      )}
    </div>
  );
}
