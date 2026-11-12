import type { ReactNode } from "react";
import { AgentWorkspace } from "../features/agents/AgentWorkspace";
import { ChangeWizardHost } from "../features/changes/ChangeWizard";
import { ChangesPage } from "../features/changes/ChangesPage";
import { MemoryPage } from "../features/library/MemoryPage";
import { OverviewPage } from "../features/projects/OverviewPage";
import { ReviewPage } from "../features/review/ReviewPage";
import { ArchitecturePage } from "../features/systems/ArchitecturePage";
import type { ConnectInfo } from "../lib/lm";
import { useApp, type Page } from "../store";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/** What each sidebar section shows. A section's sub-views are its own business (see the page components). */
const PAGES: Record<Page, () => ReactNode> = {
  overview: () => <OverviewPage />,
  agents: () => <AgentWorkspace />,
  changes: () => <ChangesPage />,
  architecture: () => <ArchitecturePage />,
  memory: () => <MemoryPage />,
  review: () => <ReviewPage />,
};

/** The app frame: sidebar, top bar, and the page for the current route. */
export function Shell({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  return (
    <div className="shell">
      <Sidebar info={info} onSettings={onSettings} onReconnect={onReconnect} />
      <div className="main">
        <Topbar />
        <main className="page-host">{PAGES[page]()}</main>
      </div>
      <ChangeWizardHost />
    </div>
  );
}
