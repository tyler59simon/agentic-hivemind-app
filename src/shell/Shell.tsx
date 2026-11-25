import { Minimize2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { AgentWorkspace } from "../features/agents/AgentWorkspace";
import { NotesPage } from "../features/notes/NotesPage";
import { HomePage } from "../features/home/HomePage";
import { InboxPage } from "../features/review/InboxPage";
import type { ConnectInfo } from "../lib/lm";
import { useApp, type Page } from "../store";
import { useLayout } from "./layout";
import { SidebarSplitter } from "./RegionSplitters";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { flushAllDrafts } from "../documents/store";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { useFormat } from "../lib/shortcuts";
import { anyLayer, modalOpen } from "../ui/layers";

/** What each sidebar section shows. A section's sub-views are its own business (see the page components). */
const PAGES: Record<Page, () => ReactNode> = {
  home: () => <HomePage />,
  agents: () => <AgentWorkspace />,
  notes: () => <NotesPage />,
  inbox: () => <InboxPage />,
};

/** The regions focus mode hides (App.css): focus that is inside one when it goes moves to the page. */
const HIDDEN_IN_FOCUS = ".sidebar, .topbar, .notebooks, .note-rail";

/** Focus mode: hides the sidebar, the top bar, the notes list and the rail, keeps the tab strip. Escape leaves it when
 *  nothing else wants the key (a dialog, a menu, the palette, a field or an editor that used it). Focus never stays inside a
 *  region that is hidden, nor falls to the page's top when the button that left the mode goes. */
function useFocusMode(host: RefObject<HTMLElement | null>) {
  const focusMode = useLayout((s) => s.focusMode);
  const was = useRef(focusMode);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (focusMode && !was.current && (lost || !!active?.closest(HIDDEN_IN_FOCUS))) host.current?.focus();
    else if (!focusMode && was.current && lost) host.current?.focus();
    was.current = focusMode;
  }, [focusMode, host]);
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || anyLayer() || modalOpen()) return;
      // A text field gives up its edit on Escape (rename, filter): that is its own.
      if ((e.target as Element | null)?.closest?.("input, textarea, select")) return;
      e.preventDefault();
      useLayout.getState().setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);
  return focusMode;
}

/** The app frame: sidebar, top bar, and the page for the current route. */
export function Shell({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  const sidebarWidth = useLayout((s) => s.sidebarWidth);
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const host = useRef<HTMLElement>(null);
  const focus = useFocusMode(host);
  const exitKeys = useFormat("focus.toggle");
  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${focus ? " focus" : ""}`} style={{ "--sidebar-w": `${sidebarWidth}rem` } as CSSProperties}>
      <Sidebar info={info} onSettings={onSettings} onReconnect={onReconnect} />
      <SidebarSplitter />
      <div className="main">
        {focus && (
          <div className="focus-bar">
            <button type="button" className="focus-exit" title={`Exit focus mode (Esc or ${exitKeys})`} onClick={() => useLayout.getState().setFocusMode(false)}>
              <Minimize2 size="1.1em" aria-hidden />Exit focus mode
            </button>
          </div>
        )}
        <Topbar />
        <main className="page-host" tabIndex={-1} ref={host}>
          <ErrorBoundary label="This page" resetKey={page} onError={() => void flushAllDrafts()}>{PAGES[page]()}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
