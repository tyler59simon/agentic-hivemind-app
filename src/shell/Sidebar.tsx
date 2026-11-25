import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ContextMenu } from "../ui/ContextMenu";
import { contextMenuKey, menuPointFor } from "../ui/focus";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, House, NotebookPen, PanelLeftClose, PanelLeftOpen, Settings, SquareCheck, Terminal, type LucideIcon } from "lucide-react";
import logo from "../assets/logo.png";
import { useAboutDialog } from "../features/help/AboutDialog";
import { ProjectSwitcher } from "../features/projects/ProjectSwitcher";
import { useInboxItems } from "../features/review/useInboxItems";
import { useShortcutsDialog } from "../features/shortcuts/ShortcutsDialog";
import { dotOf, useAttention } from "../features/terminal/attention";
import { sessionsQuery } from "../lib/agent";
import { useSystemsEnabled } from "../lib/connection";
import { copyDiagnostics, openLogsFolder, reportProblem } from "../lib/diagnostics";
import type { ConnectInfo } from "../lib/lm";
import { refreshStore } from "../lib/refresh";
import { useFormat } from "../lib/shortcuts";
import { useApp, type Page } from "../store";
import { Menu } from "../ui/Menu";
import { useWorkspace } from "../workspace/store";
import { useHidden } from "./hidden";
import { useLayout } from "./layout";

/** The sections, in the order the sidebar lists them; Settings follows them (CON-22). Skills is in Notes and Maintenance in Settings. */
export const SECTIONS: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "home", label: "Home", icon: House },
  { page: "inbox", label: "Inbox", icon: SquareCheck },
  { page: "agents", label: "Agents", icon: Terminal },
  { page: "notes", label: "Notes", icon: NotebookPen },
];

/** The sections the sidebar can show, whether or not the user hid them. */
export const useAvailableSections = () => SECTIONS;

export function Sidebar({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  const go = useApp((s) => s.go);
  const setPalette = useApp((s) => s.setPalette);
  const paletteKeys = useFormat("palette.commands");
  const toggleKeys = useFormat("sidebar.toggle");
  const shortcutKeys = useFormat("shortcuts.show");
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const setCollapsed = useLayout((s) => s.setSidebarCollapsed);
  const client = useQueryClient();
  const systemsOn = useSystemsEnabled();
  const available = useAvailableSections();
  const hidden = useHidden((s) => s.hidden);
  const setShown = useHidden((s) => s.setShown);
  // The right-click menu (or Shift+F10), and the section button that opened it (focus goes back there on Escape). It
  // closes on a click elsewhere, on Escape, or when focus leaves it.
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
    <aside className="sidebar" id="app-sidebar" aria-label="Sidebar">
      <div className="brand-block">
        <img src={logo} alt="" /><span>Hivemind</span>
        {/* Under 960 px the sidebar is icons only whatever this says, so the button is hidden there (App.css). It sits in the brand row, so the navigation keeps its height. */}
        <button type="button" className="icon-button sidebar-toggle" aria-label="Sidebar" aria-controls="app-sidebar" aria-expanded={!collapsed}
          title={`${collapsed ? "Expand" : "Collapse"} the sidebar (${toggleKeys})`} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <PanelLeftOpen size="1.35em" aria-hidden /> : <PanelLeftClose size="1.35em" aria-hidden />}
        </button>
      </div>
      <ProjectSwitcher />
      <nav className="nav" aria-label="Sections" ref={nav}>
        {available.filter((s) => !hidden.includes(s.page)).map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={`nav-item ${page === p ? "on" : ""}`} title={label} aria-current={page === p ? "page" : undefined} onClick={() => go({ page: p })}
            onContextMenu={(e) => { e.preventDefault(); setMenu(p === "home" ? null : { page: p, x: e.clientX, y: e.clientY, from: e.currentTarget }); }}
            onKeyDown={(e) => { if (contextMenuKey(e) && p !== "home") { e.preventDefault(); setMenu({ page: p, ...menuPointFor(e.currentTarget), from: e.currentTarget }); } }}>
            <Icon size="1.35em" aria-hidden /><span className="grow">{label}</span>
            {p === "inbox" && inboxTotal > 0 && <span className="nav-count" title={`${inboxTotal} waiting for you`} aria-label={`${inboxTotal} waiting for you`}>{inboxTotal}</span>}
            {mark(p) && <span className={`nav-dot ${p === "agents" && waiting ? "waiting" : p === "agents" && attention === "done" ? "done" : p === "notes" ? "unsaved" : ""}`} title={mark(p)!} aria-label={mark(p)!} />}
          </button>
        ))}
        <button className="nav-item" onClick={onSettings}><Settings size="1.35em" aria-hidden /><span className="grow">Settings</span></button>
      </nav>
      {menu && (
        <ContextMenu at={menu} from={menu.from} label={`${SECTIONS.find((x) => x.page === menu.page)?.label ?? "Section"} actions`} onClose={() => setMenu(null)}>
          <li role="none"><button role="menuitem" onClick={() => {
            setShown(menu.page, false); setMenu(null);
            // The section that had focus is gone: move it to the current section, or the first one.
            requestAnimationFrame(() => (nav.current?.querySelector<HTMLElement>(".nav-item.on") ?? nav.current?.querySelector<HTMLElement>(".nav-item"))?.focus());
          }}>
            <span className="grow">Hide from sidebar</span></button></li>
          <li className="menu-note" role="none">Show it again in Settings</li>
        </ContextMenu>
      )}
      <Menu className="user-menu" label="Account and settings" up
        button={<><span className="avatar" aria-hidden>{user.slice(0, 1).toUpperCase()}</span><span className="grow">{user}</span><ChevronDown size="1.1em" aria-hidden /></>}>
        {(close) => (
          <>
            <li role="none"><button role="menuitem" onClick={() => { close(); onSettings(); }}><span className="grow">Settings</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); setPalette("commands"); }}><span className="grow">Command palette</span><kbd>{paletteKeys}</kbd></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); refreshStore(client); }}><span className="grow">Refresh</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); onReconnect(); }}><span className="grow">Reconnect to Living Memory</span></button></li>
            {/* Help. Each item closes the menu first, which puts the focus on the account button: the dialogs return it there. */}
            <li className="menu-sep" role="none" />
            <li role="none"><button role="menuitem" onClick={() => { close(); useAboutDialog.getState().show(); }}><span className="grow">About Hivemind</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); useShortcutsDialog.getState().show(); }}><span className="grow">Keyboard shortcuts</span><kbd>{shortcutKeys}</kbd></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); void openLogsFolder(); }}><span className="grow">Open logs folder</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); void copyDiagnostics(); }}><span className="grow">Copy diagnostics</span></button></li>
            <li role="none"><button role="menuitem" onClick={() => { close(); void reportProblem(); }}><span className="grow">Report a problem</span></button></li>
            <li className="menu-note" role="none" title={info.script}>{info.root}</li>
          </>
        )}
      </Menu>
    </aside>
  );
}
