import { Minimize2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { AgentWorkspace } from "../features/agents/AgentWorkspace";
import { NotesPage } from "../features/notes/NotesPage";
import { HomePage } from "../features/home/HomePage";
import { InboxPage } from "../features/review/InboxPage";
import type { ConnectInfo } from "../lib/lm";
import { useApp, type Page } from "../store";
import { useLayout } from "./layout";
import { hiddenBy, skipToContent } from "./regions";
import { SidebarSplitter } from "./RegionSplitters";
import { Sidebar } from "./Sidebar";
import { useBudget } from "./useBudget";
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

/** Focus never stays on something the layout just hid, nor falls to the top of the page when the control that was used goes:
 *  entering focus mode, collapsing the sidebar and a window width that folds regions move it to a control that is drawn, the
 *  sidebar button or the page. The page takes the focus with a visible outline (App.css). */
function useKeepFocus(host: RefObject<HTMLElement | null>, focus: boolean, collapsed: boolean, folded: boolean, overlay: boolean) {
  const was = useRef(focus);
  useLayoutEffect(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const hidden = hiddenBy(focus, collapsed, folded, overlay);
    const inHidden = !!hidden && !!active?.closest(hidden);
    const entered = focus && !was.current, left = !focus && was.current;
    was.current = focus;
    if (!(inHidden || ((entered || left) && lost))) return;
    const toggle = !focus && !folded && active?.closest(".shell > .splitter") ? document.querySelector<HTMLElement>(".sidebar-toggle") : null;
    (toggle ?? host.current)?.focus();
  }, [focus, collapsed, folded, overlay, host]);
}

/** Escape leaves focus mode when nothing else wants the key: a dialog, a menu or the palette (layers), an editor or board that
 *  used it (the event is `defaultPrevented`), or a text field, which gives up its edit on Escape (rename, filter). A field
 *  that has no Escape action cannot be told from one that has, so every field keeps the key. */
function useFocusEscape(focus: boolean) {
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || anyLayer() || modalOpen()) return;
      if ((e.target as Element | null)?.closest?.("input, textarea, select")) return;
      e.preventDefault();
      useLayout.getState().setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);
}

/** The app frame: sidebar, top bar, and the page for the current route. */
export function Shell({ info, onSettings, onReconnect }: { info: ConnectInfo; onSettings: () => void; onReconnect: () => void }) {
  const page = useApp((s) => s.route.page);
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const focus = useLayout((s) => s.focusMode);
  const budget = useBudget();
  const host = useRef<HTMLElement>(null);
  useKeepFocus(host, focus, collapsed, budget.folded, budget.overlay);
  useFocusEscape(focus);
  const exitKeys = useFormat("focus.toggle");
  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${focus ? " focus" : ""}`} style={{ "--sidebar-w": `${budget.sidebar}rem` } as CSSProperties}>
      {/* The first thing the Tab key reaches; it shows only while it has the focus (App.css). */}
      <button type="button" className="skip-link" onClick={skipToContent}>Skip to content</button>
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
