import { useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useCurrentProject } from "../features/projects/useProject";
import { systemsQuery } from "../features/systems/useSystem";
import { sessionsQuery } from "../lib/agent";
import { useSystemsEnabled } from "../lib/connection";
import { useApp } from "../store";
import { activeTab, useWorkspace } from "../workspace/store";
import { SECTIONS } from "./Sidebar";

interface Crumb { label: string; go?: () => void }

const MEMORY_VIEWS = { graph: "Graph", activity: "Activity", tags: "Tags" } as const;

function useCrumbs(): Crumb[] {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const { project } = useCurrentProject();
  const noteTitle = useWorkspace((s) => activeTab(s)?.title);
  const systemsOn = useSystemsEnabled();
  const sessions = useQuery({ ...sessionsQuery(), enabled: systemsOn && route.page === "agents" });
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn && route.page === "architecture" });
  const root: Crumb = { label: project?.name ?? "All memory", go: () => go({ page: "overview" }) };
  if (route.page === "overview") return route.view === "work" ? [root, { label: "Open work" }] : [{ label: "Projects" }, { label: root.label }];
  const section: Crumb = { label: SECTIONS.find((s) => s.page === route.page)?.label ?? route.page, go: () => go({ page: route.page }) };
  const leaf = route.page === "memory" ? (route.view === "notes" ? noteTitle : route.view && MEMORY_VIEWS[route.view])
    : route.page === "agents" ? (route.view === "new" ? "New session" : sessions.data?.find((s) => s.id === route.session)?.title)
    : route.page === "architecture" ? systems.data?.systems.find((s) => s.slug === route.system)?.name
    : undefined;
  return leaf ? [root, section, { label: leaf }] : [root, section];
}

/** Breadcrumb on the left; "Search project" on the right (Ctrl+K), which shows its results in Memory. */
export function Topbar() {
  const crumbs = useCrumbs();
  const go = useApp((s) => s.go);
  const routeQuery = useApp((s) => (s.route.page === "memory" ? s.route.q ?? "" : ""));
  const scoped = useApp((s) => !!s.project);
  const [query, setQuery] = useState(routeQuery);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setQuery(routeQuery), [routeQuery]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if ((key === "k" && !e.shiftKey) || (key === "f" && e.shiftKey)) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
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
      <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); go({ page: "memory", q: query.trim() || undefined }); }}>
        <Search size="1.2em" aria-hidden />
        <input ref={input} value={query} placeholder={scoped ? "Search project" : "Search memory"} aria-label={scoped ? "Search project" : "Search memory"}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }} />
        <kbd>Ctrl K</kbd>
      </form>
    </header>
  );
}
