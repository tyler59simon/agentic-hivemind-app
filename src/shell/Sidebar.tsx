import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Database, GitBranch, House, Network, SquareCheck, Terminal, type LucideIcon } from "lucide-react";
import logo from "../assets/logo.png";
import { ProjectSwitcher } from "../features/projects/ProjectSwitcher";
import { sessionsQuery } from "../lib/agent";
import { useSystemsEnabled } from "../lib/connection";
import type { ConnectInfo } from "../lib/lm";
import { refreshStore } from "../lib/refresh";
import { useApp, type Page } from "../store";
import { Menu } from "../ui/Menu";
import { useWorkspace } from "../workspace/store";

/** The sections, in the order the sidebar lists them. */
export const SECTIONS: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "overview", label: "Overview", icon: House },
  { page: "agents", label: "Agent Workspace", icon: Terminal },
  { page: "changes", label: "Changes", icon: GitBranch },
  { page: "architecture", label: "Architecture", icon: Network },
  { page: "memory", label: "Memory", icon: Database },
  { page: "review", label: "Review", icon: SquareCheck },
];

export function Sidebar({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  const go = useApp((s) => s.go);
  const setPalette = useApp((s) => s.setPalette);
  const client = useQueryClient();
  const systemsOn = useSystemsEnabled();
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn });
  const running = sessions.data?.some((s) => s.status === "running");
  const unsaved = useWorkspace((s) => Object.values(s.dirty).some(Boolean));
  const user = info.user || "You";
  const mark = (p: Page) => (p === "agents" && running ? "An agent session is running" : p === "memory" && unsaved ? "A note has unsaved edits" : null);

  return (
    <aside className="sidebar">
      <div className="brand-block"><img src={logo} alt="" /><span>Hivemind</span></div>
      <ProjectSwitcher />
      <nav className="nav" aria-label="Sections">
        {SECTIONS.map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={`nav-item ${page === p ? "on" : ""}`} aria-current={page === p ? "page" : undefined} onClick={() => go({ page: p })}>
            <Icon size="1.35em" aria-hidden /><span className="grow">{label}</span>
            {mark(p) && <span className="nav-dot" title={mark(p)!} aria-label={mark(p)!} />}
          </button>
        ))}
      </nav>
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
