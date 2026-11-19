// The Executive page: Today, Portfolio, the assistant, Communications and Briefings, scoped by the sidebar's project picker.
// Capture (the header button or Ctrl+Shift+C) is open from every tab.
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { openExecutive, useApp, type ExecutiveTab } from "../../store";
import { PageHeader, Tabs } from "../../ui/Page";
import { AgentTab } from "./AgentTab";
import { BriefingsTab } from "./BriefingsTab";
import { CaptureDialog, ReviewDialog } from "./Capture";
import { CommsTab } from "./CommsTab";
import { PortfolioTab } from "./PortfolioTab";
import { TodayTab } from "./TodayTab";
import { useInbox, usePortfolio } from "./useExecutive";

export function ExecutivePage() {
  const route = useApp((s) => (s.route.page === "executive" ? s.route : undefined));
  const tab = route?.tab ?? "today";
  const data = usePortfolio();
  const inbox = useInbox();
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); setCapturing(true); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const overdue = data.attention.overdue.length + data.crossProject.filter((c) => c.timing === "overdue").length;
  const tabs: { id: ExecutiveTab; label: string; count?: number }[] = [
    { id: "today", label: "Today", count: inbox.count || undefined },
    { id: "portfolio", label: "Portfolio" },
    { id: "agent", label: "Assistant" },
    { id: "comms", label: "Communications" },
    { id: "briefings", label: "Briefings" },
  ];
  const scope = data.project?.name ?? "All projects";
  return (
    <div className="page exec">
      <PageHeader eyebrow="Executive" title={scope}
        subtitle={overdue ? `${overdue} overdue commitment${overdue === 1 ? "" : "s"} · ${data.attention.atRisk.length} project${data.attention.atRisk.length === 1 ? "" : "s"} at risk` : "Decisions, commitments, risks and updates, kept for you from daily work."}
        actions={<button className="primary" onClick={() => setCapturing(true)} title="Ctrl+Shift+C"><Plus size="1em" aria-hidden /> Capture</button>} />
      <Tabs label="Executive" value={tab} onChange={(id) => openExecutive({ tab: id })} items={tabs} />
      {tab === "today" && <TodayTab project={data.project} projects={data.projects} attention={data.attention} crossProject={data.crossProject} loading={data.loading} error={data.error} />}
      {tab === "portfolio" && <PortfolioTab rows={data.rows} projects={data.projects} project={data.project} loading={data.loading} error={data.error} />}
      {tab === "agent" && <AgentTab project={data.project} picked={route?.session} />}
      {tab === "comms" && <CommsTab project={data.project} projects={data.projects} picked={route?.draft} />}
      {tab === "briefings" && <BriefingsTab project={data.project} projects={data.projects} picked={route?.briefing} />}
      {capturing && <CaptureDialog projects={data.projects} project={data.project} onClose={() => setCapturing(false)} />}
      {route?.capture && <ReviewDialog id={route.capture} projects={data.projects} onClose={() => openExecutive({ ...route, capture: undefined })} />}
    </div>
  );
}
