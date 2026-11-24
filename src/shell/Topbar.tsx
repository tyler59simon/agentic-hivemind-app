import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { NotesSearchBox } from "../features/search/NotesSearch";
import { useNotesSearch } from "../features/search/store";
import { useCurrentProject } from "../features/projects/useProject";
import { systemsQuery } from "../features/systems/useSystem";
import { sessionsQuery } from "../lib/agent";
import { useSystemsEnabled } from "../lib/connection";
import { OTHER_FOLDERS } from "../lib/folders";
import { useApp } from "../store";
import { fileName, pageTitle } from "../lib/notebooks";
import { isLoose } from "../lib/opens";
import { useNotebookTitle } from "../features/notes/notebookTitle";
import { activeTab, tabLabel, useWorkspace } from "../workspace/store";
import { SECTIONS } from "./Sidebar";

interface Crumb { label: string; go?: () => void }

const NOTES_VIEWS = { tasks: "Tasks", views: "Views", tags: "Tags", graph: "Graph", wiki: "Wiki", skills: "Skills" } as const;

function useCrumbs(): Crumb[] {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const { project } = useCurrentProject();
  const other = useApp((s) => s.project === OTHER_FOLDERS);
  // A note's title, or the name of a tab that is not a page: a new note or page, a comparison, Find in files (CONR-16).
  const noteTitle = useWorkspace((s) => {
    const tab = activeTab(s);
    return tab && tab.kind !== "file" ? tabLabel(tab) : undefined;
  });
  const page = useWorkspace((s) => { const t = activeTab(s); return t?.kind === "file" ? t.file : undefined; });
  const notebook = useNotebookTitle(page && !isLoose(page) ? page.notebook : undefined, route.page === "notes");
  const systemsOn = useSystemsEnabled();
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn && route.page === "agents" });
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn && route.page === "home" && route.tab === "architecture" });
  const root: Crumb = { label: project?.name ?? (other ? "Other folders" : "All memory"), go: () => go({ page: "home" }) };
  if (route.page === "home") {
    const system = route.tab === "architecture" ? systems.data?.systems.find((s) => s.slug === route.system)?.name : undefined;
    return system ? [{ label: "Projects" }, root, { label: system }] : [{ label: "Projects" }, { label: root.label }];
  }
  const section: Crumb = { label: SECTIONS.find((s) => s.page === route.page)?.label ?? route.page, go: () => go({ page: route.page }) };
  if (route.page === "notes" && route.view) return [root, section, { label: NOTES_VIEWS[route.view] }];
  if (route.page === "notes" && page && isLoose(page)) return [root, section, { label: "Opened files" }, { label: fileName(page.path) }];
  if (route.page === "notes" && page) {
    return [root, section, { label: notebook ?? "Notebook" }, { label: pageTitle(page.path) }];
  }
  const leaf = route.page === "notes" ? noteTitle
    : route.page === "agents" ? (route.view === "new" ? "New session" : sessions.data?.find((s) => s.id === route.session)?.title)
    : undefined;
  return leaf ? [root, section, { label: leaf }] : [root, section];
}

/** Breadcrumb on the left; one unified search box on the right (Ctrl+K / Ctrl+Shift+F) on every page (CON-11). */
export function Topbar() {
  const crumbs = useCrumbs();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if ((key === "k" && !e.shiftKey) || (key === "f" && e.shiftKey)) {
        e.preventDefault();
        useNotesSearch.getState().show();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Layers size="1.25em" aria-hidden />
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={i}>
              {i > 0 && <span className="crumb-sep" aria-hidden>/</span>}
              {c.go && !last ? <button className="crumb" onClick={c.go}>{c.label}</button>
                : <span className={`crumb ${last ? "here" : ""}`} aria-current={last ? "page" : undefined}>{c.label}</span>}
            </Fragment>
          );
        })}
      </nav>
      <NotesSearchBox inputRef={input} />
    </header>
  );
}
