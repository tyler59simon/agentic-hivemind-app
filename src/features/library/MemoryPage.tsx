// Memory sub-views (Graph, Tags, Activity, History) until CON-12 moves Graph/Tags into Notes and CON-21 retires Activity/History.
// The old Memory library list and search were retired by CON-10 (Notes tree) and CON-11 (unified top-bar search).
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { useLogEnabled } from "../../lib/connection";
import { useApp } from "../../store";
import { PageHeader } from "../../ui/Page";
import { useWorkspace } from "../../workspace/store";
import { GraphView } from "../graph/GraphView";
import { ActivityView } from "../history/HistoryViews";
import { LogView } from "../history/LogView";
import { useCurrentProject } from "../projects/useProject";
import { TaxonomyView } from "../taxonomy/TaxonomyView";

type MemoryView = "graph" | "activity" | "history" | "tags";

const VIEWS: Record<MemoryView, { title: string; subtitle: string; body: (tag?: string) => ReactNode }> = {
  graph: { title: "Graph", subtitle: "Notes and the links between them.", body: (tag?: string) => <GraphView key={tag} tag={tag} /> },
  tags: { title: "Tags", subtitle: "The taxonomy every note is filed under.", body: () => <TaxonomyView /> },
  activity: { title: "Activity", subtitle: "Who changed what, newest first.", body: () => <ActivityView /> },
  history: { title: "History", subtitle: "Notes and agent sessions, newest first.", body: () => <LogView /> },
};

export function MemoryPage() {
  const route = useApp((s) => s.route);
  const domain = useApp((s) => s.domain);
  const go = useApp((s) => s.go);
  const logOn = useLogEnabled();
  const { project } = useCurrentProject();
  const requested = route.page === "memory" ? route.view : undefined;
  const active: MemoryView = requested && (requested !== "history" || logOn) ? requested : "graph";
  const sub = VIEWS[active];
  const newNote = () => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: project ? [project.tag] : undefined, domain: domain ?? undefined } });

  return (
    <div className="memory">
      <div className="page fill-page">
        <PageHeader title={sub.title} subtitle={sub.subtitle}
          actions={<>
            <button className={`text ${active === "graph" ? "on" : ""}`} onClick={() => go({ page: "memory", view: "graph" })}>Graph</button>
            <button className={`text ${active === "tags" ? "on" : ""}`} onClick={() => go({ page: "memory", view: "tags" })}>Tags</button>
            <button className={`text ${active === "activity" ? "on" : ""}`} onClick={() => go({ page: "memory", view: "activity" })}>Activity</button>
            {logOn && <button className={`text ${active === "history" ? "on" : ""}`} onClick={() => go({ page: "memory", view: "history" })}>History</button>}
            <button className="primary big" onClick={newNote} title="New note (Ctrl+N)"><Plus size="1.2em" aria-hidden />Capture a note</button>
          </>} />
        <div className="sub-view">{sub.body(project?.tag)}</div>
      </div>
    </div>
  );
}
