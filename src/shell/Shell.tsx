import type { ReactNode } from "react";
import { AgentWorkspace } from "../features/agents/AgentWorkspace";
import { NotesPage } from "../features/notes/NotesPage";
import { HomePage } from "../features/home/HomePage";
import { MaintenancePage } from "../features/maintenance/MaintenancePage";
import { InboxPage } from "../features/review/InboxPage";
import { SkillsPage } from "../features/skills/SkillsPage";
import { WorkflowsPage } from "../features/workflows/WorkflowsPage";
import type { ConnectInfo } from "../lib/lm";
import { useApp, type Page } from "../store";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { flushAllDrafts } from "../documents/store";
import { ErrorBoundary } from "../ui/ErrorBoundary";

/** What each sidebar section shows. A section's sub-views are its own business (see the page components). */
const PAGES: Record<Page, () => ReactNode> = {
  home: () => <HomePage />,
  agents: () => <AgentWorkspace />,
  notes: () => <NotesPage />,
  maintenance: () => <MaintenancePage />,
  inbox: () => <InboxPage />,
  skills: () => <SkillsPage />,
  workflows: () => <WorkflowsPage />,
};

/** The app frame: sidebar, top bar, and the page for the current route. */
export function Shell({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  return (
    <div className="shell">
      <Sidebar info={info} onSettings={onSettings} onReconnect={onReconnect} />
      <div className="main">
        <Topbar />
        <main className="page-host">
          <ErrorBoundary label="This page" resetKey={page} onError={() => void flushAllDrafts()}>{PAGES[page]()}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
