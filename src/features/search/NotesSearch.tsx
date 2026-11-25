// One search box on every page with grouped results (NS-4A, CON-11): Memory notes first, then This notebook, Other
// notebooks / Notebooks. Supports project scoping, status/type filters for memory notes,
// page filters, semantic Meaning toggle, and keyboard navigation (arrows, Enter, Ctrl+Enter, Escape).
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useConnection, useProjectsEnabled } from "../../lib/connection";
import { domains, list, search, taxonomy } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { indexSearch, marked, tagsQuery, INDEX_KEY, type IndexFilters, type PageKind } from "../../lib/noteindex";
import { useNoteTypes } from "../../lib/noteTypes";
import { isLoose } from "../../lib/opens";
import { useApp } from "../../store";
import { activeTab, useWorkspace } from "../../workspace/store";
import { openPage } from "../notes/actions";
import { projectsQuery, useCurrentProject } from "../projects/useProject";
import { SemanticHint } from "./SemanticHint";
import { buildGroups, flatRows, MODIFIED, moveActive, type ResultRow } from "./groups";
import {
  byUpdatedDesc, filterMemoryItems, fromNoteRow, fromSearchHit, MEMORY_DISPLAY_LIMIT, memorySearchOptions,
  type MemoryStatus,
} from "./memory";
import { filtered, memoryOnlyFiltered, NO_FILTERS, pageOnlyFiltered, useNotesSearch, type SearchFilters } from "./store";

const SETTLE_MS = 150;

/** `value`, once it has stopped changing for a moment. */
function useSettled(value: string, ms = SETTLE_MS) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The notebook of the page being read, when it is a folder notebook's. */
const useCurrentNotebook = () => useWorkspace((s) => {
  const tab = activeTab(s);
  return tab?.kind === "file" && tab.file && !isLoose(tab.file) ? tab.file.notebook : undefined;
});

const asIndexFilters = (f: SearchFilters): IndexFilters => ({
  ...(f.folder.trim() ? { folder: f.folder.trim() } : {}),
  ...(f.tag ? { tag: f.tag } : {}),
  ...(f.kind ? { kind: f.kind as PageKind } : {}),
  ...(f.modified !== "any" ? { modifiedAfterMs: Date.now() - (MODIFIED.find((m) => m.id === f.modified)?.ms ?? 0) } : {}),
});

function Marked({ text }: { text: string }) {
  return <>{marked(text).map((p, i) => (p.on ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

/** Open what a result row names, switching to the Notes workspace when needed. */
export function openRow(row: ResultRow, split: boolean) {
  const target = row.open;
  if ("page" in target) openPage(target.page, { split });
  else {
    useApp.getState().setDomain(target.note.domain);
    useWorkspace.getState().openNote(target.note.ref, { split, title: target.note.title });
  }
}

function Filters({ notebooks, projectName }: { notebooks: { id: string; title: string }[]; projectName?: string }) {
  const filters = useNotesSearch((s) => s.filters);
  const set = useNotesSearch((s) => s.setFilters);
  const meaning = useNotesSearch((s) => s.meaning);
  const setMeaning = useNotesSearch((s) => s.setMeaning);
  const pageTags = useQuery(tagsQuery());
  const taxEnabled = useConnection((s) => s.commands.includes("taxonomy"));
  const memTags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy, enabled: taxEnabled });
  const types = useNoteTypes();

  const mergedTags = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const t of pageTags.data ?? []) map.set(t.tag, t.count);
    for (const t of memTags.data?.tags ?? []) if (!map.has(t)) map.set(t, null);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pageTags.data, memTags.data]);

  return (
    <div className="search-filters" role="group" aria-label="Filters">
      {projectName && (
        <button type="button" className={`chip${filters.allProjects ? " on" : ""}`} aria-pressed={filters.allProjects}
          onClick={() => set({ allProjects: !filters.allProjects })}
          title={filters.allProjects ? "Searching Memory notes across all projects" : `Scoped to ${projectName}; click to include all memory`}>
          {filters.allProjects ? "All memory" : projectName}
        </button>
      )}
      <select aria-label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value as MemoryStatus })}>
        <option value="active">Active notes</option>
        <option value="archived">Archive</option>
        <option value="any">Any status</option>
      </select>
      <select aria-label="Note type" value={filters.noteType} onChange={(e) => set({ noteType: e.target.value })}>
        <option value="">Any type</option>
        {types.all.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
      </select>
      <button type="button" className={`chip${meaning ? " on" : ""}`} aria-pressed={meaning} onClick={() => setMeaning(!meaning)}
        title="Also find pages that are about what you typed, not only pages that use the words">Meaning</button>
      <select aria-label="Notebook" value={filters.notebook} onChange={(e) => set({ notebook: e.target.value })}>
        <option value="">All notebooks</option>
        {notebooks.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
      <input aria-label="Folder" placeholder="Folder" value={filters.folder} onChange={(e) => set({ folder: e.target.value })} />
      <select aria-label="Tag" value={filters.tag} onChange={(e) => set({ tag: e.target.value })}>
        <option value="">Any tag</option>
        {filters.tag && !mergedTags.some(([t]) => t === filters.tag) && <option value={filters.tag}>{filters.tag}</option>}
        {mergedTags.map(([t, count]) => <option key={t} value={t}>{count !== null ? `#${t} (${count})` : t}</option>)}
      </select>
      <select aria-label="Kind" value={filters.kind} onChange={(e) => set({ kind: e.target.value as PageKind | "" })}>
        <option value="">Any kind</option>
        <option value="md">Markdown</option>
        <option value="hmdoc">Rich page</option>
        <option value="canvas">Canvas</option>
        <option value="txt">Text</option>
      </select>
      <select aria-label="Modified" value={filters.modified} onChange={(e) => set({ modified: e.target.value })}>
        {MODIFIED.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {filtered(filters) && <button type="button" className="ghost" onClick={() => set(NO_FILTERS)}>Clear filters</button>}
    </div>
  );
}

/** The unified search box in the top bar on every page, with its grouped results panel. `inputRef` handles Ctrl+K / Ctrl+Shift+F. */
export function NotesSearchBox({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { query, filters, meaning, open, focusTick, setQuery, show, close } = useNotesSearch();
  const domain = useApp((s) => s.domain);
  const { project } = useCurrentProject();
  const projectsOn = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled: projectsOn });
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled: open && !domain });
  const searchDomain = domain ?? known.data?.domains[0]?.name ?? null;
  const current = useCurrentNotebook();
  const canSearchMem = useConnection((s) => s.commands.includes("search"));
  const canListMem = useConnection((s) => s.commands.includes("search"));
  const notebooks = useQuery(notebooksQuery());
  const settled = useSettled(query);
  const trimmed = settled.trim();
  const wrap = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const pageOnly = pageOnlyFiltered(filters);
  const memOnly = memoryOnlyFiltered(filters);
  const askedPages = (trimmed.length > 0 || pageOnly || !!filters.tag) && !memOnly;
  const askedMemory = (trimmed.length > 0 || memOnly || !!filters.tag) && !pageOnly;
  const asked = askedPages || askedMemory;
  const base = useMemo(() => asIndexFilters(filters), [filters]);
  const projectTag = project && !filters.allProjects ? project.tag : undefined;

  useEffect(() => { if (focusTick) { inputRef.current?.focus(); inputRef.current?.select(); } }, [focusTick, inputRef]);
  // A click outside the box and its panel closes the panel.
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);

  // Memory notes: text search via `alm search`, or filter-only browse via `alm list` (e.g. Status = Archive with empty query).
  const memOpts = useMemo(
    () => (searchDomain ? memorySearchOptions({ query: trimmed, domain: searchDomain, status: filters.status, noteType: filters.noteType, tag: filters.tag, projectTag }) : null),
    [searchDomain, trimmed, filters.status, filters.noteType, filters.tag, projectTag],
  );
  const memSearch = useQuery({
    queryKey: ["search", "unified", searchDomain, trimmed, filters.status, filters.noteType, filters.tag, projectTag],
    queryFn: () => search(memOpts!),
    enabled: open && askedMemory && trimmed.length > 0 && canSearchMem && !!memOpts,
  });
  const listTags = useMemo(() => [projectTag, filters.tag || undefined].filter(Boolean) as string[], [projectTag, filters.tag]);
  const memBrowse = useQuery({
    queryKey: ["list", "unified", filters.status, filters.noteType, listTags],
    queryFn: () => list({
      allDomains: true,
      status: filters.status === "active" ? "active" : "any",
      types: filters.noteType ? [filters.noteType] : undefined,
      tags: listTags.length ? listTags : undefined,
      summary: true,
      limit: 100,
    }),
    enabled: open && askedMemory && trimmed.length === 0 && canListMem,
  });

  // Folder notebooks: with a notebook chosen one search answers; otherwise this notebook and the others are asked apart.
  const chosen = filters.notebook || undefined;
  const here = useQuery({
    queryKey: [INDEX_KEY, "search", "here", settled, filters.notebook, filters.folder, filters.tag, filters.kind, filters.modified, current, meaning],
    queryFn: () => indexSearch(settled, { ...base, notebook: chosen ?? current }, 20, meaning),
    enabled: open && askedPages && !!(chosen ?? current),
  });
  const other = useQuery({
    queryKey: [INDEX_KEY, "search", "other", settled, filters.notebook, filters.folder, filters.tag, filters.kind, filters.modified, current, meaning],
    queryFn: () => indexSearch(settled, { ...base, excludeNotebook: current }, 20, meaning),
    enabled: open && askedPages && !chosen,
  });
  const memoryItems = useMemo(() => {
    if (!askedMemory) return [];
    const required = [projectTag, filters.tag || undefined].filter(Boolean) as string[];
    const raw = trimmed.length > 0
      ? (memSearch.data?.results ?? []).map(fromSearchHit)
      : byUpdatedDesc((memBrowse.data?.notes ?? []).map(fromNoteRow));
    return filterMemoryItems(raw, { status: filters.status, noteType: filters.noteType, tags: required }).slice(0, MEMORY_DISPLAY_LIMIT);
  }, [askedMemory, trimmed, memSearch.data, memBrowse.data, filters.status, filters.noteType, filters.tag, projectTag]);

  const projectNames = useMemo(
    () => new Map((registry.data?.projects ?? []).map((p) => [p.tag, p.name])),
    [registry.data],
  );
  const titles = useMemo(() => new Map((notebooks.data ?? []).map((n) => [n.id, n.title])), [notebooks.data]);
  const chosenHere = chosen === undefined || chosen === current;
  const groups = useMemo(() => buildGroups({
    current, titles,
    here: askedPages && chosenHere ? here.data?.hits ?? [] : [],
    other: askedPages ? (chosen && !chosenHere ? here.data?.hits ?? [] : other.data?.hits ?? []) : [],
    memory: memoryItems,
    projectNames,
    query: settled,
  }), [current, titles, askedPages, chosen, chosenHere, here.data, other.data, memoryItems, projectNames, settled]);
  const rows = useMemo(() => flatRows(groups), [groups]);
  useEffect(() => setActive(rows.length ? 0 : -1), [rows]);

  const scanning = (here.data?.state ?? other.data?.state) === "scanning";
  const how = meaning ? here.data?.meaning ?? other.data?.meaning : undefined;
  const busy = here.isFetching || other.isFetching || memSearch.isFetching || memBrowse.isFetching;
  const choose = (row: ResultRow | undefined, split: boolean) => { if (!row) return; close(); inputRef.current?.blur(); openRow(row, split); };
  const placeholder = project && !filters.allProjects ? `Search ${project.name} and notebooks` : "Search notes and pages";

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { if (open) close(); else e.currentTarget.blur(); return; }
    if (!open) { if (e.key === "ArrowDown") show(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((i) => moveActive(i, e.key, rows.length)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[active], e.ctrlKey || e.metaKey); }
  };

  return (
    // The panel also closes when the keyboard takes the focus out of the box and its panel (Tab past the last filter, F6).
    <div className="top-search-wrap" ref={wrap} onBlur={(e) => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) close(); }}>
      <form className="top-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <Search size="1.2em" aria-hidden />
        <input ref={inputRef} value={query} placeholder={placeholder} aria-label={placeholder} role="combobox" aria-expanded={open} aria-controls="notes-search-results"
          autoComplete="off" onChange={(e) => setQuery(e.target.value)} onFocus={show} onKeyDown={onKeyDown} />
        <kbd>Ctrl K</kbd>
      </form>
      {/* Always in the page, so the count is read when it changes (WCAG 4.1.3); the list below is not a live region. */}
      <div className="visually-hidden" role="status">{open && asked && !busy ? (rows.length ? `${rows.length} ${rows.length === 1 ? "result" : "results"}` : "No matches.") : ""}</div>
      {open && (
        <div className="search-panel" id="notes-search-results" onMouseDown={(e) => { if (!(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
          <Filters notebooks={notebooks.data ?? []} projectName={project?.name} />
          {scanning && <p className="muted small pad">Still indexing, so some pages may be missing.</p>}
          {meaning && <SemanticHint state={how ?? "off"} />}
          {!asked && <p className="muted small pad">Type to search memory notes and notebook pages, or pick a filter.</p>}
          {asked && !rows.length && !busy && <p className="muted pad">No matches.</p>}
          <div role="listbox" aria-label="Results">
            {groups.map((g) => (
              <section key={g.id} className="search-group" aria-label={g.title}>
                <h3>{g.title}</h3>
                <ul>
                  {g.rows.map((row) => {
                    const at = rows.indexOf(row);
                    return (
                      <li key={row.key}>
                        <button role="option" aria-selected={at === active} className={at === active ? "on" : ""} onMouseEnter={() => setActive(at)}
                          onClick={(e) => choose(row, e.ctrlKey || e.metaKey)} onAuxClick={(e) => { if (e.button === 1) choose(row, true); }}>
                          <span className="search-title"><Marked text={row.marked ?? row.title} />{row.detail && <span className="muted small"> · {row.detail}</span>}</span>
                          {row.snippet && <span className="search-snippet muted small"><Marked text={row.snippet} /></span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
