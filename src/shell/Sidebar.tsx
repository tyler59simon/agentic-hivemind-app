import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, House, LayoutDashboard, NotebookPen, Wrench, Sparkles, SquareCheck, Terminal, Workflow, type LucideIcon } from "lucide-react";
import logo from "../assets/logo.png";
import { ProjectSwitcher } from "../features/projects/ProjectSwitcher";
import { useInboxItems } from "../features/review/useInboxItems";
import { dotOf, useAttention } from "../features/terminal/attention";
import { sessionsQuery } from "../lib/agent";
import { useMaintenanceEnabled, useSystemsEnabled, useViewsEnabled, useWikiEnabled } from "../lib/connection";
import type { ConnectInfo } from "../lib/lm";
import { refreshStore } from "../lib/refresh";
import { useApp, type Page } from "../store";
import { Menu } from "../ui/Menu";
import { useWorkspace } from "../workspace/store";
import { useHidden } from "./hidden";

/** The sections, in the order the sidebar lists them. */
export const SECTIONS: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "home", label: "Home", icon: House },
  { page: "agents", label: "Agent Workspace", icon: Terminal },
  { page: "notes", label: "Notes", icon: NotebookPen },
  { page: "dashboards", label: "Dashboards", icon: LayoutDashboard },
  { page: "wiki", label: "Wiki", icon: BookOpen },
  { page: "maintenance", label: "Maintenance", icon: Wrench },
  { page: "inbox", label: "Inbox", icon: SquareCheck },
  { page: "skills", label: "Skills", icon: Sparkles },
  { page: "workflows", label: "Workflows", icon: Workflow },
];

/** The sections this store offers (some need a newer Living Memory), whether or not the user hid them. */
export function useAvailableSections() {
  const on: Partial<Record<Page, boolean>> = {
    dashboards: useViewsEnabled(), wiki: useWikiEnabled(), maintenance: useMaintenanceEnabled(),
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
  // The right-click menu, and the section button that opened it (focus goes back there on Escape). It closes on a click
  // elsewhere, on Escape inside it, or when focus leaves it.
  const [menu, setMenu] = useState<{ page: Page; x: number; y: number; from: HTMLButtonElement } | null>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn });
  const attention = useAttention((s) => dotOf(Object.values(s.byId)));
  const waiting = sessions.data?.some((s) => s.status === "waiting") || attention === "waiting";
  const running = sessions.data?.some((s) => s.status === "running");
  const unsaved = useWorkspace((s) => s.panes.some((p) => p.tabs.some((t) => s.dirty[t.id])));
  // One count for the Inbox: the same total as its All tab.
  const inboxTotal = useInboxItems().total;
  const user = info.user || "You";
  const mark = (p: Page) => (p === "agents" && waiting ? "An agent session is waiting for you" : p === "agents" && attention === "done" ? "A terminal finished" : p === "agents" && running ? "An agent session is running" : p === "notes" && unsaved ? "A document has unsaved edits" : null);

  return (
    <aside className="sidebar">
      <div className="brand-block"><img src={logo} alt="" /><span>Hivemind</span></div>
      <ProjectSwitcher />
      <nav className="nav" aria-label="Sections" ref={nav}>
        {available.filter((s) => !hidden.includes(s.page)).map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={`nav-item ${page === p ? "on" : ""}`} aria-current={page === p ? "page" : undefined} onClick={() => go({ page: p })}
            onContextMenu={(e) => { e.preventDefault(); setMenu(p === "home" ? null : { page: p, x: e.clientX, y: e.clientY, from: e.currentTarget }); }}>
            <Icon size="1.35em" aria-hidden /><span className="grow">{label}</span>
            {p === "inbox" && inboxTotal > 0 && <span className="nav-count" title={`${inboxTotal} waiting for you`} aria-label={`${inboxTotal} waiting for you`}>{inboxTotal}</span>}
            {mark(p) && <span className={`nav-dot ${p === "agents" && waiting ? "waiting" : p === "agents" && attention === "done" ? "done" : p === "notes" ? "unsaved" : ""}`} title={mark(p)!} aria-label={mark(p)!} />}
          </button>
        ))}
      </nav>
      {menu && (
        <ul className="menu-list context" role="menu" style={{ top: menu.y, left: menu.x }} onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          // preventDefault keeps focus in the menu on a click: WebKit (macOS) does not focus a clicked button, so the blur
          // below would close the menu before the click runs.
          onKeyDown={(e) => { if (e.key === "Escape") { setMenu(null); menu.from.focus(); } }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null); }}>
          <li role="none"><button role="menuitem" autoFocus onClick={() => {
            setShown(menu.page, false); setMenu(null);
            // The section that had focus is gone: move it to the current section, or the first one.
            requestAnimationFrame(() => (nav.current?.querySelector<HTMLElement>(".nav-item.on") ?? nav.current?.querySelector<HTMLElement>(".nav-item"))?.focus());
          }}>
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
