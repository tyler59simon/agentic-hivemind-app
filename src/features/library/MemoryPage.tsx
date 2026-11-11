import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, Link as LinkIcon, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { classify } from "../../lib/errors";
import { domains, list, search, taxonomy, type SearchOptions } from "../../lib/lm";
import { sections } from "../../lib/note";
import { highlight, terms } from "../../lib/text";
import { useApp, type Shelf } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink, dayMonth, PageHeader, Tabs } from "../../ui/Page";
import { NoteRail } from "../../workspace/RightSidebar";
import { hasTabs, railShown, useWorkspace } from "../../workspace/store";
import { OpenTabs, Workspace } from "../../workspace/Workspace";
import { GraphView } from "../graph/GraphView";
import { ActivityView } from "../history/HistoryViews";
import { useNoteLinks } from "../links/useLinks";
import { HoverPreview } from "../preview/HoverPreview";
import { Triage } from "../projects/TriageDialog";
import { useCurrentProject, useProject } from "../projects/useProject";
import { TaxonomyView } from "../taxonomy/TaxonomyView";
import { noteQuery } from "../viewer/NoteView";
import { byUpdated, filterItems, fromHit, fromRow, GROUPS, searchFilters, type Group, type Item, type Scope } from "./library";

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

function Marked({ text, words }: { text: string; words: string[] }) {
  return <>{highlight(text, words).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const openNote = (item: Pick<Item, "ref" | "title">, split = false) => useWorkspace.getState().openNote(item.ref, { title: item.title, split });

/** The selected note, summarised beside the list. */
function Preview({ item }: { item: Item }) {
  const note = useQuery(noteQuery(item.ref));
  const { note: links } = useNoteLinks(item.ref);
  const n = note.data;
  const summary = n ? sections(n.body).summary : undefined;
  const linked = [...(links?.outgoing ?? []), ...(links?.incoming ?? [])].filter((e, i, all) => all.findIndex((x) => x.node.ref === e.node.ref) === i).slice(0, 6);
  const confirmed = n?.confirmed?.length ? n.confirmed[n.confirmed.length - 1] : undefined;
  return (
    <div className="lib-preview">
      <span className={`badge type-${item.type}`}>{item.type}</span>
      <h2>{item.title}</h2>
      <div className="page-meta">
        <span className={`status-chip cap ${item.status}`}>{item.status}</span>
        <span className="muted">{confirmed ? `Last confirmed ${dayMonth(confirmed)}` : `Updated ${dayMonth(item.updated)}`}</span>
      </div>
      {note.isLoading && <p className="muted">Loading…</p>}
      {note.error && <p className="error">{classify(note.error).message}</p>}
      {summary && <><h3>Summary</h3><div className="markdown"><Markdown>{summary}</Markdown></div></>}
      {!!linked.length && (
        <>
          <h3>Connections</h3>
          {linked.map((e) => (
            <HoverPreview key={e.node.ref} refId={e.node.ref}>
              <button className="conn-link" onClick={(ev) => openNote(e.node, ev.ctrlKey || ev.metaKey)}><LinkIcon size="1.1em" aria-hidden />{e.node.title}</button>
            </HoverPreview>
          ))}
        </>
      )}
      {!!item.tags.length && <div className="tags">{item.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      <div className="lib-preview-actions">
        <button className="outline" onClick={() => openNote(item, true)} title="Open beside the note you have open (Ctrl+click)">Open to the side</button>
        <ArrowLink onClick={() => openNote(item)}>Open full note</ArrowLink>
      </div>
      <p className="lib-source muted small">Source: Living Memory · {item.domain}</p>
    </div>
  );
}

const SHELVES: { id: Shelf; label: string }[] = [{ id: "active", label: "Active" }, { id: "archived", label: "Archive" }, { id: "any", label: "Any status" }];

/** Mock 08: search, type tabs, and Status / Scope / Tag filters over the notes; a preview of the selected one. */
function Library() {
  const { domain, shelf, setShelf, setDomain, go } = useApp();
  const routeQuery = useApp((s) => (s.route.page === "memory" ? s.route.q ?? "" : ""));
  const { project } = useCurrentProject();
  const [query, setQuery] = useState(routeQuery);
  const [group, setGroup] = useState<Group>("all");
  const [scope, setScope] = useState<Scope>(project ? "project" : "fallback");
  const [tag, setTag] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [triage, setTriage] = useState(false);
  useEffect(() => setQuery(routeQuery), [routeQuery]);
  // The scope follows the project picker.
  useEffect(() => setScope((s) => (project ? "project" : s === "project" ? "fallback" : s)), [project?.slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const settled = useDebounced(query.trim(), 250);
  useEffect(() => { if (settled !== routeQuery) go({ page: "memory", q: settled || undefined }, { replace: true }); }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const tags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const inProject = scope === "project" && !!project;
  const members = useProject(inProject ? project.slug : undefined).rows;
  const everything = useQuery({
    queryKey: ["list", "*", "any", "summary"], queryFn: () => list({ allDomains: true, status: "any", summary: true }),
    enabled: !settled && !inProject && scope !== "active",
  });
  const inDomain = useQuery({
    queryKey: ["list", domain, "any", "summary"], queryFn: () => list({ domain: domain!, status: "any", summary: true }),
    enabled: !settled && scope === "active" && !!domain,
  });
  const asked = searchFilters({ group, shelf, tag, projectTag: inProject ? project.tag : undefined });
  const hits = useQuery({
    queryKey: ["search", domain, settled, inProject ? "all" : scope, asked],
    queryFn: () => search({ query: settled, domain: domain!, scope: inProject ? "all" : (scope as SearchOptions["scope"]), ...asked }),
    enabled: !!settled && !!domain,
  });
  const source = settled ? hits : inProject ? members : scope === "active" ? inDomain : everything;

  const items = useMemo(() => {
    const raw = settled ? (hits.data?.results ?? []).map(fromHit)
      : byUpdated(((inProject ? members.data : scope === "active" ? inDomain.data : everything.data)?.notes ?? []).map(fromRow));
    const required = [...(inProject ? [project.tag] : []), ...(tag ? [tag] : [])];
    const allowed = settled || inProject || scope !== "fallback" || !domain ? null : [domain, ...(known.data?.global_domains ?? [])];
    return filterItems(raw, { group, shelf, tags: required, domains: allowed });
  }, [settled, hits.data, members.data, inDomain.data, everything.data, inProject, project, scope, tag, group, shelf, domain, known.data]);
  const current = items.find((i) => i.ref === selected) ?? items[0];
  const words = terms(settled);
  const newNote = () => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: project ? [project.tag] : undefined, domain: domain ?? undefined } });

  return (
    <div className="page">
      <PageHeader title="Memory" subtitle={project ? "The reasoning your project keeps." : "The reasoning your agents and you keep."}
        actions={<>
          <button className="text" onClick={() => go({ page: "memory", view: "graph" })}>Graph</button>
          <button className="text" onClick={() => go({ page: "memory", view: "activity" })}>Activity</button>
          <button className="text" onClick={() => go({ page: "memory", view: "tags" })}>Tags</button>
          <button className="primary big" onClick={newNote} title="New note (Ctrl+N)"><Plus size="1.2em" aria-hidden />Capture a note</button>
        </>} />
      <label className="lib-search">
        <Search size="1.2em" aria-hidden />
        <input value={query} placeholder="Search decisions, lessons, risks…" aria-label="Search notes" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="lib-bar">
        <Tabs items={GROUPS} value={group} onChange={setGroup} label="Note types" />
        <div className="lib-filters">
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Scope">
            {project && <option value="project">This project</option>}
            <option value="fallback">Domain + global</option>
            <option value="active">Domain only</option>
            <option value="all">All domains</option>
          </select>
          {!inProject && scope !== "all" && (
            <select value={domain ?? ""} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
              {!domain && <option value="">Choose a domain…</option>}
              {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.active})</option>)}
            </select>
          )}
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
            <option value="">Any tag</option>
            {tags.data?.tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={shelf} onChange={(e) => setShelf(e.target.value as Shelf)} aria-label="Status">
            {SHELVES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div className="split wide-rail lib-split">
        <div className="split-main">
          {source.isLoading && <p className="muted">Loading…</p>}
          {source.error && <p className="error">{classify(source.error).message}</p>}
          {settled && hits.data?.fallback && <p className="muted small">Nothing matched in this domain; these are from other domains.</p>}
          {settled && (hits.data?.results.length ?? 0) >= asked.limit && (
            <p className="muted small">Only the best {asked.limit} matches are shown or filtered. Add a word to the search if a note is missing.</p>
          )}
          {!source.isLoading && !source.error && !items.length && (
            <p className="muted">
              {settled ? "No notes match this search and these filters." : inProject ? <>No notes are tagged with <code>{project.tag}</code> here yet.</> : "No notes here."}
              {inProject && !settled && <> <button className="link" onClick={() => setTriage(true)}>Find notes for this project</button></>}
            </p>
          )}
          <ol className="lib-list">
            {items.map((n) => (
              <li key={n.ref}>
                <button className={`lib-row ${current?.ref === n.ref ? "on" : ""}`} aria-current={current?.ref === n.ref}
                  onClick={(e) => (e.ctrlKey || e.metaKey ? openNote(n, true) : setSelected(n.ref))} onDoubleClick={() => openNote(n)}
                  onAuxClick={(e) => { if (e.button === 1) openNote(n, true); }} title="Double-click to open; Ctrl+click to open beside">
                  <FileText size="1.5em" aria-hidden />
                  <span className="lib-row-main">
                    <span className="lib-row-title"><Marked text={n.title} words={words} /></span>
                    <span className="lib-row-meta">
                      <span className="cap">{n.type}</span><span>{dayMonth(n.updated)}</span>
                      {n.domain !== domain && <span>{n.domain}</span>}
                      {n.status !== "active" && <span className={`badge status-${n.status}`}>{n.status}</span>}
                    </span>
                    {n.text && <span className="lib-row-text"><Marked text={oneLine(n.text)} words={words} /></span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {inProject && !!items.length && <p className="muted small"><button className="link" onClick={() => setTriage(true)}>Find more notes for this project</button></p>}
        </div>
        <aside className="split-rail">{current ? <Preview key={current.ref} item={current} /> : <p className="muted">Select a note to preview it.</p>}</aside>
      </div>
      {triage && project && <Triage project={project} onClose={() => setTriage(false)} />}
    </div>
  );
}

const VIEWS = {
  graph: { title: "Graph", subtitle: "Notes and the links between them.", body: (tag?: string) => <GraphView key={tag} tag={tag} /> },
  activity: { title: "Activity", subtitle: "Who changed what, newest first.", body: () => <ActivityView /> },
  tags: { title: "Tags", subtitle: "The taxonomy every note is filed under.", body: () => <TaxonomyView /> },
};

/** Memory: the library, its Graph / Activity / Tags views, and the open notes as tabs and side-by-side panes. */
export function MemoryPage() {
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const open = useWorkspace(hasTabs);
  const rail = useWorkspace(railShown);
  const { project } = useCurrentProject();
  const view = route.page === "memory" ? route.view : undefined;

  if (view === "notes" && open) {
    return <div className="notes-area"><Workspace />{rail && <NoteRail />}</div>;
  }
  const sub = view && view !== "notes" ? VIEWS[view] : null;
  return (
    <div className="memory">
      {open && <OpenTabs />}
      {sub ? (
        <div className="page fill-page">
          <PageHeader title={sub.title} subtitle={sub.subtitle}
            actions={<button className="text" onClick={() => go({ page: "memory" })}><ArrowLeft size="1.1em" aria-hidden />Library</button>} />
          <div className="sub-view">{sub.body(project?.tag)}</div>
        </div>
      ) : <Library />}
    </div>
  );
}
