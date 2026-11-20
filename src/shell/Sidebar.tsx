import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BookOpen, BriefcaseBusiness, ChevronDown, Database, GitBranch, House, LayoutDashboard, Network, Wrench, ScrollText, Sparkles, SquareCheck, Terminal, Workflow, type LucideIcon } from "lucide-react";
import logo from "../assets/logo.png";
import { ProjectSwitcher } from "../features/projects/ProjectSwitcher";
import { dotOf, useAttention } from "../features/terminal/attention";
import { sessionsQuery } from "../lib/agent";
import { useMaintenanceEnabled, useRecapEnabled, useSystemsEnabled, useViewsEnabled, useWikiEnabled } from "../lib/connection";
import type { ConnectInfo } from "../lib/lm";
import { refreshStore } from "../lib/refresh";
import { useApp, type Page } from "../store";
import { Menu } from "../ui/Menu";
import { useWorkspace } from "../workspace/store";
import { useHidden } from "./hidden";

/** The sections, in the order the sidebar lists them. */
export const SECTIONS: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "overview", label: "Overview", icon: House },
  { page: "executive", label: "Executive", icon: BriefcaseBusiness },
  { page: "agents", label: "Agent Workspace", icon: Terminal },
  { page: "changes", label: "Changes", icon: GitBranch },
  { page: "architecture", label: "Architecture", icon: Network },
  { page: "memory", label: "Memory", icon: Database },
  { page: "dashboards", label: "Dashboards", icon: LayoutDashboard },
  { page: "wiki", label: "Wiki", icon: BookOpen },
  { page: "recap", label: "Recap", icon: ScrollText },
  { page: "maintenance", label: "Maintenance", icon: Wrench },
  { page: "review", label: "Review", icon: SquareCheck },
  { page: "skills", label: "Skills", icon: Sparkles },
  { page: "workflows", label: "Workflows", icon: Workflow },
];

/** The sections this store offers (some need a newer Living Memory), whether or not the user hid them. */
export function useAvailableSections() {
  const on: Partial<Record<Page, boolean>> = {
    dashboards: useViewsEnabled(), wiki: useWikiEnabled(), recap: useRecapEnabled(), maintenance: useMaintenanceEnabled(),
  };
  return SECTIONS.filter((s) => on[s.page] ?? true);
}

export function Sidebar({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  const go = useApp((s) => s.go);
  const setPalette = useApp((s) => s.setPalette);
  const client = useQueryClient();
  const systemsOn = useSystemsEnabled();
  const available = useAvailableSections();
  const hidden = useHidden((s) => s.hidden);
  const setShown = useHidden((s) => s.setShown);
  const [menu, setMenu] = useState<{ page: Page; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [menu]);
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn });
  const attention = useAttention((s) => dotOf(Object.values(s.byId)));
  const waiting = sessions.data?.some((s) => s.status === "waiting") || attention === "waiting";
  const running = sessions.data?.some((s) => s.status === "running");
  const unsaved = useWorkspace((s) => Object.values(s.dirty).some(Boolean));
  const user = info.user || "You";
  const mark = (p: Page) => (p === "agents" && waiting ? "An agent session is waiting for you" : p === "agents" && attention === "done" ? "A terminal finished" : p === "agents" && running ? "An agent session is running" : p === "memory" && unsaved ? "A note has unsaved edits" : null);

  return (
    <aside className="sidebar">
      <div className="brand-block"><img src={logo} alt="" /><span>Hivemind</span></div>
      <ProjectSwitcher />
      <nav className="nav" aria-label="Sections">
        {available.filter((s) => !hidden.includes(s.page)).map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={`nav-item ${page === p ? "on" : ""}`} aria-current={page === p ? "page" : undefined} onClick={() => go({ page: p })}
            onContextMenu={(e) => { e.preventDefault(); setMenu(p === "overview" ? null : { page: p, x: e.clientX, y: e.clientY }); }}>
            <Icon size="1.35em" aria-hidden /><span className="grow">{label}</span>
            {mark(p) && <span className={`nav-dot ${p === "agents" && waiting ? "waiting" : p === "agents" && attention === "done" ? "done" : p === "memory" ? "unsaved" : ""}`} title={mark(p)!} aria-label={mark(p)!} />}
          </button>
        ))}
      </nav>
      {menu && (
        <ul className="menu-list context" role="menu" style={{ top: menu.y, left: menu.x }} onMouseDown={(e) => e.stopPropagation()}>
          <li role="none"><button role="menuitem" autoFocus onClick={() => { setShown(menu.page, false); setMenu(null); }}>
            <span className="grow">Hide from sidebar</span></button></li>
          <li className="menu-note" role="none">Show it again in Settings</li>
        </ul>
      )}
      <Menu className="user-menu" label="Account and settings" up
        button={<><span className="avatar" aria-hidden>{user.slice(0, 1).toUpperCase()}</span><span className="grow">{user}</span><ChevronDown size="1.1em" aria-hidden /></>}>
        {(close) => (
          <>
            <li role="none"><button role="menuitem" onClick={() => { close(); onSettings(); }}><span className="grow">Settings</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); setPalette("commands"); }}><span className="grow">Command palette</span><kbd>Ctrl P</kbd></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); refreshStore(client); }}><span className="grow">Refresh</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); onReconnect(); }}><span className="grow">Reconnect to Living Memory</span></button></li>
            <li className="menu-note" role="none" title={info.script}>{info.root}</li>
          </>
        )}
      </Menu>
    </aside>
  );
}
