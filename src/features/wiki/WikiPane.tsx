import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Clock, Download, House, List, ListTree, Package, RefreshCw, Search } from "lucide-react";
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useAgentWikiEnabled, useWikiEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { realProject } from "../../lib/folders";
import { domains } from "../../lib/lm";
import { exportWiki } from "../../lib/wiki";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { useShownEngines } from "../agents/engines";
import { domainOf } from "../executive/items";
import { useCurrentProject } from "../projects/useProject";
import { AgentMainPage, AgentPage } from "./agent";
import { listenOnce, startWikiBuild, useWikiBuild } from "./build";
import { BuildDialog, BuildStrip, EmptyEdition } from "./BuildUi";
import { AzPage, FolderPage, MainPage, MissingPage, NotePage, ProjectPage, RecentPage, SearchPage, SectionPage } from "./pages";
import { NavProvider } from "./parts";
import { useAgentWiki, useWiki } from "./useWiki";
import { WeeklyRebuildToggle } from "./WeeklyRebuildToggle";
import { NoNotes, WikiProjects } from "./WikiProjects";
import { buildBlocked, crumbs, projectAt, projectRows, resolvePage, searchNotes, treeKeys, treeOpen, treeRows, wikiRoute, type TreeIcon, type WikiIndex, type WikiView } from "./wiki";

const TREE_ICONS: Record<TreeIcon, typeof House> = { home: House, box: Package, list: List, clock: Clock };

/** The wiki's own page tree: projects and their sections, then the browse pages. A branch opens to show its children. */
function Tree({ ix, view, goTo }: { ix: WikiIndex; view: WikiView; goTo: (at: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Showing a page opens the branches it lies in (without closing any the reader opened).
  useEffect(() => {
    const o = treeOpen(ix, view);
    if (o.project) setOpen((s) => ({ ...s, [`p-${o.project}`]: true, ...(o.code ? { [`code-${o.project}`]: true } : {}) }));
  }, [ix, view]);
  const rows = useMemo(() => treeRows(ix, open), [ix, open]);
  const on = treeKeys(ix, view).find((k) => rows.some((r) => r.kind === "row" && r.at === k));
  return (
    <nav className="wiki-tree" aria-label="Wiki pages">
      {rows.map((r, i) => {
        if (r.kind === "label") return <div key={`l${i}`} className="wiki-tree-label">{r.label}</div>;
        const Icon = r.icon ? TREE_ICONS[r.icon] : null;
        return (
          <div key={r.at || "main"} className={`wiki-tree-row depth-${r.depth}${r.at === on ? " on" : ""}`}>
            {r.branch ? (
              <button className="wiki-tree-toggle" aria-expanded={r.expanded} aria-label={`${r.expanded ? "Collapse" : "Expand"} ${r.label}`}
                onClick={() => setOpen((s) => ({ ...s, [r.branch!]: !s[r.branch!] }))}><ChevronRight size="1.05em" aria-hidden /></button>
            ) : r.depth > 0 || !r.icon ? <span className="wiki-tree-spacer" /> : null}
            <button className="wiki-tree-link" aria-current={r.at === on ? "page" : undefined} onClick={() => goTo(r.at)}>
              {Icon && <Icon size="1.2em" aria-hidden />}
              <span className="wiki-tree-text">{r.label}</span>
              {r.flag && <span className={`wiki-flag ${r.flag}`}>{r.flag}</span>}
              {r.count != null && <span className="n">{r.count}</span>}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function Breadcrumbs({ ix, view, goTo }: { ix: WikiIndex; view: WikiView; goTo: (at: string) => void }) {
  const trail = crumbs(ix, view);
  if (trail.length < 2) return null;
  return (
    <nav className="wiki-crumbs" aria-label="Wiki breadcrumb">
      {trail.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight size="1em" aria-hidden />}
          {i === trail.length - 1 ? <span className="here" aria-current="page">{c.label}</span> : <button className="text" onClick={() => goTo(c.at)}>{c.label}</button>}
        </Fragment>
      ))}
    </nav>
  );
}

function Body({ view, query, hits, agent }: { view: WikiView; query: string; hits: ReturnType<typeof searchNotes>; agent: boolean }) {
  if (query) return <SearchPage query={query} hits={hits} />;
  switch (view.kind) {
    case "main": return agent ? <AgentMainPage /> : <MainPage />;
    case "project": return agent ? <AgentMainPage /> : <ProjectPage project={view.project} />;
    case "section": return <SectionPage project={view.project} section={view.section} />;
    case "folder": return <FolderPage folder={view.folder} />;
    case "note": return view.note.page ? <AgentPage note={view.note} /> : <NotePage note={view.note} />;
    case "az": return <AzPage />;
    case "recent": return <RecentPage />;
    case "missing": return <MissingPage at={view.at} />;
  }
}

/** Notes > Wiki: the picked project's memory read as a wiki, built from its notes by Living Memory. The page tree is on the left;
 *  "Export HTML…" saves the same wiki as one file. Where Living Memory can, a second edition is offered: the agent-written wiki,
 *  whose sections and pages an agent chose and wrote from the notes, with citations (for a project, with a weekly rebuild switch).
 *  With All projects picked it lists the projects, and "Whole domain" opens the wiki of a whole domain with its domain picker. */
export function WikiPane() {
  const enabled = useWikiEnabled();
  const agentEnabled = useAgentWikiEnabled();
  const client = useQueryClient();
  const building = useWikiBuild((s) => s.running);
  const route = useApp((s) => (s.route.page === "notes" && s.route.view === "wiki" ? s.route : null));
  const appDomain = useApp((s) => s.domain);
  const go = useApp((s) => s.go);
  const setProject = useApp((s) => s.setProject);
  const slug = useApp((s) => realProject(s.project));
  const { project, registry } = useCurrentProject();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled });
  const fallback = route?.domain ?? appDomain ?? known.data?.domains[0]?.name ?? null;
  // A picked project reads in its own domain (its charter's); with none picked the domain is the route's or the app's.
  const waiting = !!slug && !project && registry.isLoading;
  const domain = waiting ? null : slug ? domainOf(project, fallback ?? "") || null : fallback;
  const whole = !slug && !!route?.whole;
  const list = !slug && !whole;
  const scope = slug ?? ""; // the agent edition's scope: "" is the whole domain
  const [archived, setArchived] = useState(false);
  const blocked = buildBlocked(useShownEngines().shows("claude"));
  const [planning, setPlanning] = useState(false);
  const [q, setQ] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const structured = useWiki(domain, archived);
  const agentMode = agentEnabled && route?.edition === "agent" && !list;
  // A project with no notes in its domain has no wiki to show in either edition.
  const noNotes = !!slug && !!domain && structured.query.isSuccess && !structured.ix?.projects.has(slug);
  const agent = useAgentWiki(domain, scope, agentMode && !noNotes);
  const { query, ix } = agentMode ? agent : structured;
  const noEdition = agentMode && agent.query.isSuccess && agent.query.data === null;
  // A project's structured wiki opens on its own page.
  const at = route?.at || (slug && !agentMode ? projectAt(slug) : undefined);
  const view = useMemo<WikiView>(() => (ix ? resolvePage(ix, at) : { kind: "main" }), [ix, at]);
  const asked = useDeferredValue(q.trim());
  const hits = useMemo(() => (ix && asked ? searchNotes(ix.model.notes, asked) : []), [ix, asked]);
  // A build this view did not start (the weekly rebuild) still refreshes it when it ends.
  useEffect(() => { listenOnce(client).catch(() => undefined); }, [client]);

  // The edition is part of the route, so Back returns to the edition a page was in.
  const open = useCallback((o: { at?: string; agent: boolean }) => {
    setQ(""); setNavOpen(false);
    go(wikiRoute(domain ?? undefined, { ...o, whole }));
  }, [go, domain, whole]);
  const goTo = useCallback((at: string) => open({ at, agent: agentMode }), [open, agentMode]);
  const nav = useMemo(() => (ix ? { ix, goTo } : null), [ix, goTo]);
  // A new page starts at the top.
  useEffect(() => { document.querySelector(".notes-lists")?.scrollTo({ top: 0 }); }, [at, asked]);

  // An address of one edition names nothing in the other, so switching edition starts at its main page.
  const pickEdition = (next: "structured" | "agent") => {
    if ((next === "agent") === agentMode) return;
    open({ agent: next === "agent" });
  };

  const exportHtml = async () => {
    if (!domain) return;
    setExporting(true);
    try {
      const path = await exportWiki(domain, archived, { agent: agentMode, project: agentMode ? scope || undefined : undefined });
      if (path) toast(`Saved the ${domain} wiki to ${path}`);
    } catch (e) { toast(classify(e).message, "error"); }
    finally { setExporting(false); }
  };

  if (!enabled) return <p className="muted">This version of Living Memory has no <code>wiki</code> command. Update Living Memory to use the wiki.</p>;
  // The pages of a wiki have a title of their own (the page header, an h1). Every other state (the project list, loading, an empty
  // wiki) gets a hidden one, so the page always has exactly one.
  const titled = !list && !waiting && !query.isLoading && !noNotes && !(query.error && !ix) && !!domain && !noEdition && !!ix && !!nav;
  return (
    <div className="page wiki-page">
      {!titled && <h1 className="visually-hidden">Wiki</h1>}
      {!list && (
        <div className="wiki-bar">
          {slug ? <b className="wiki-scope">{project?.name ?? slug}</b> : (
            <>
              <button className="text" onClick={() => go(wikiRoute(domain ?? undefined))}>All projects</button>
              <select value={domain ?? ""} onChange={(e) => go(wikiRoute(e.target.value, { agent: agentMode, whole: true }))} aria-label="Domain">
                {!domain && <option value="">Choose a domain…</option>}
                {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.active})</option>)}
                {domain && !known.data?.domains.some((d) => d.name === domain) && <option value={domain}>{domain}</option>}
              </select>
            </>
          )}
          {agentEnabled && (
            <div className="segmented compact" role="radiogroup" aria-label="Edition">
              <button role="radio" aria-checked={!agentMode} className={agentMode ? "" : "on"} onClick={() => pickEdition("structured")} title="Organised by fixed rules: projects, sections by note type, one page per note">Structured</button>
              <button role="radio" aria-checked={agentMode} className={agentMode ? "on" : ""} onClick={() => pickEdition("agent")} title="An agent chooses the sections and writes each page from several notes, with citations">Agent-written</button>
            </div>
          )}
          {!agentMode && <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Show retired</label>}
          <span className="fill" />
          {agentMode && !!slug && !!domain && !noNotes && !blocked && <WeeklyRebuildToggle domain={domain} project={slug} />}
          {agentMode && !noEdition && !noNotes && (
            <button className="outline" onClick={() => setPlanning(true)} disabled={!domain || !!building || !ix || !!blocked} title={blocked ?? "Rewrite the pages whose sources changed, and place new notes"}>
              <RefreshCw size="1.1em" aria-hidden />Refresh
            </button>
          )}
          <button className="outline" onClick={exportHtml} disabled={!domain || exporting || noEdition || noNotes} title="Save this wiki as one HTML file that opens offline">
            <Download size="1.1em" aria-hidden />{exporting ? "Exporting…" : "Export HTML…"}
          </button>
        </div>
      )}
      <BuildStrip />
      {planning && domain && (
        <BuildDialog domain={domain} project={scope} hasEdition={!noEdition} onClose={() => setPlanning(false)}
          onStart={(restructure) => { setPlanning(false); void startWikiBuild(client, domain, scope, restructure); }} />
      )}
      {list ? (
        registry.isLoading ? <p className="muted">Loading projects…</p>
          : <WikiProjects rows={projectRows(registry.data?.projects ?? [], structured.query.data, fallback ?? "")} domain={domain}
            onWhole={() => go(wikiRoute(domain ?? undefined, { whole: true }))}
            onPick={(picked) => { setProject(picked); go(wikiRoute(undefined)); }} />
      ) : waiting || query.isLoading ? <p className="muted">{agentMode ? "Reading the agent-written wiki…" : "Building the wiki…"}</p>
        : noNotes ? <NoNotes domain={domain!} name={project?.name ?? slug!} tag={project?.tag ?? `project/${slug}`} />
        : query.error && !ix ? <p className="error">{classify(query.error).message}</p>
        : !domain ? <p className="muted">Choose a domain to read as a wiki.</p>
        : noEdition ? <EmptyEdition domain={domain} project={scope} busy={!!building} blocked={blocked} onBuild={() => setPlanning(true)} />
        : ix && nav && (
          <div className="wiki-layout">
            <aside className="wiki-side" aria-label="Wiki navigation">
              <label className="wiki-search">
                <Search size="1.2em" aria-hidden />
                <input value={q} placeholder="Search this wiki" aria-label="Search this wiki" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />
              </label>
              <button className="text wiki-nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}><ListTree size="1.2em" aria-hidden />Pages</button>
              <div className={`wiki-tree-box${navOpen ? " open" : ""}`}><Tree ix={ix} view={view} goTo={goTo} /></div>
            </aside>
            <NavProvider value={nav}>
              <div className="wiki-content">
                {!asked && <Breadcrumbs ix={ix} view={view} goTo={goTo} />}
                <Body view={view} query={asked} hits={hits} agent={agentMode} />
              </div>
            </NavProvider>
          </div>
        )}
    </div>
  );
}
