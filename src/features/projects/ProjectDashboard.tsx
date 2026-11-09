import type { Tab } from "../../workspace/store";

export function ProjectDashboard({ tab }: { tab: Tab }) {
  return <div className="pad muted">Project {tab.slug} — coming soon</div>;
}
