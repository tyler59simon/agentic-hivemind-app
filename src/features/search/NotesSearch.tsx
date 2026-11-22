// The Notes page's search box and its results panel (NS-4A). On the Notes page the top bar's box reads "Search pages";
// typing opens a panel under it with four groups (this notebook, other notebooks, Living Memory pages, memory notes),
// filters, and the keys: arrows move, Enter opens, Ctrl+Enter opens beside, Escape closes. The open tabs stay visible.
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { useDocsSearch } from "../../lib/connection";
import { docSearch, lmNotebooksQuery, search } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { indexSearch, marked, tagsQuery, INDEX_KEY, type IndexFilters, type PageKind } from "../../lib/noteindex";
import { isLoose } from "../../lib/opens";
import { useApp } from "../../store";
import { activeTab, useWorkspace } from "../../workspace/store";
import { openPage } from "../notes/actions";
import { SemanticHint } from "./SemanticHint";
import { buildGroups, flatRows, MODIFIED, moveActive, type ResultRow } from "./groups";
import { filtered, NO_FILTERS, useNotesSearch, type SearchFilters } from "./store";

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
  return tab?.kind === "file" && tab.file && !isLoose(tab.file) && !tab.file.notebook.startsWith("lm:") ? tab.file.notebook : undefined;
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

/** Open what a result row names. */
export function openRow(row: ResultRow, split: boolean) {
  const target = row.open;
  if ("page" in target) openPage(target.page, { split });
  else if ("lm" in target) openPage({ notebook: lmContainer(target.lm.domain, target.lm.notebook), path: target.lm.path }, { split });
  else {
    useApp.getState().setDomain(target.note.domain);
    useWorkspace.getState().openNote(target.note.ref, { split, title: target.note.title });
  }
}

function Filters({ notebooks }: { notebooks: { id: string; title: string }[] }) {
  const filters = useNotesSearch((s) => s.filters);
  const set = useNotesSearch((s) => s.setFilters);
  const meaning = useNotesSearch((s) => s.meaning);
  const setMeaning = useNotesSearch((s) => s.setMeaning);
  const tags = useQuery(tagsQuery());
  return (
    <div className="search-filters" aria-label="Filters">
      <button type="button" className={`chip${meaning ? " on" : ""}`} aria-pressed={meaning} onClick={() => setMeaning(!meaning)}
        title="Also find pages that are about what you typed, not only pages that use the words">Meaning</button>
      <select aria-label="Notebook" value={filters.notebook} onChange={(e) => set({ notebook: e.target.value })}>
        <option value="">All notebooks</option>
        {notebooks.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
      <input aria-label="Folder" placeholder="Folder" value={filters.folder} onChange={(e) => set({ folder: e.target.value })} />
      <select aria-label="Tag" value={filters.tag} onChange={(e) => set({ tag: e.target.value })}>
        <option value="">Any tag</option>
        {filters.tag && !(tags.data ?? []).some((t) => t.tag === filters.tag) && <option value={filters.tag}>#{filters.tag}</option>}
        {(tags.data ?? []).map((t) => <option key={t.tag} value={t.tag}>#{t.tag} ({t.count})</option>)}
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
      {filtered(filters) && <button className="ghost" onClick={() => set(NO_FILTERS)}>Clear filters</button>}
    </div>
  );
}

/** The search box of the Notes page, with its results panel. `inputRef` is the top bar's, for Ctrl+K and Ctrl+Shift+F. */
export function NotesSearchBox({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { query, filters, meaning, open, focusTick, setQuery, show, close } = useNotesSearch();
  const go = useApp((s) => s.go);
  const domain = useApp((s) => s.domain);
  const current = useCurrentNotebook();
  const lmSearch = useDocsSearch();
  const notebooks = useQuery(notebooksQuery());
  const lmNotebooks = useQuery({ ...lmNotebooksQuery(), enabled: lmSearch });
  const settled = useSettled(query);
  const wrap = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const narrowed = filtered(filters);
  const asked = settled.trim().length > 0 || narrowed;
  const base = useMemo(() => asIndexFilters(filters), [filters]);

  useEffect(() => { if (focusTick) { inputRef.current?.focus(); } }, [focusTick, inputRef]);
  // A click outside the box and its panel closes the panel.
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);

  // With a notebook chosen in the filters one search answers; otherwise this notebook and the others are asked apart, so
  // a big notebook elsewhere cannot push this one's pages out.
  const chosen = filters.notebook || undefined;
  const here = useQuery({
    queryKey: [INDEX_KEY, "search", "here", settled, filters, current, meaning],
    queryFn: () => indexSearch(settled, { ...base, notebook: chosen ?? current }, 20, meaning),
    enabled: open && asked && !!(chosen ?? current),
  });
  const other = useQuery({
    queryKey: [INDEX_KEY, "search", "other", settled, filters, current, meaning],
    queryFn: () => indexSearch(settled, { ...base, excludeNotebook: current }, 20, meaning),
    enabled: open && asked && !chosen,
  });
  const lm = useQuery({ queryKey: ["doc-search", settled], queryFn: () => docSearch(settled.trim(), 8), enabled: open && lmSearch && settled.trim().length > 0 && !narrowed });
  const memory = useQuery({
    queryKey: ["search", domain, settled, "notes-page"],
    queryFn: () => search({ query: settled.trim(), domain: domain!, scope: "fallback", limit: 5 }),
    enabled: open && !!domain && settled.trim().length > 0 && !narrowed,
  });

  const titles = useMemo(() => new Map((notebooks.data ?? []).map((n) => [n.id, n.title])), [notebooks.data]);
  const chosenHere = chosen === undefined || chosen === current;
  const groups = useMemo(() => buildGroups({
    current, titles,
    here: chosenHere ? here.data?.hits ?? [] : [],
    other: chosen && !chosenHere ? here.data?.hits ?? [] : other.data?.hits ?? [],
    lmSearch, lm: lm.data ?? [], lmNotebooks: lmNotebooks.data?.notebooks ?? [],
    memory: memory.data?.results ?? [], query: settled,
  }), [current, titles, chosen, chosenHere, here.data, other.data, lmSearch, lm.data, lmNotebooks.data, memory.data, settled]);
  const rows = useMemo(() => flatRows(groups), [groups]);
  useEffect(() => setActive(rows.length ? 0 : -1), [rows]);

  const scanning = (here.data?.state ?? other.data?.state) === "scanning";
  // What the index said of meaning search; it is the same for both searches.
  const how = meaning ? here.data?.meaning ?? other.data?.meaning : undefined;
  const busy = here.isFetching || other.isFetching;
  const choose = (row: ResultRow | undefined, split: boolean) => { if (!row) return; close(); inputRef.current?.blur(); openRow(row, split); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { if (open) close(); else e.currentTarget.blur(); return; }
    if (!open) { if (e.key === "ArrowDown") show(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((i) => moveActive(i, e.key, rows.length)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(rows[active], e.ctrlKey || e.metaKey); }
  };

  return (
    <div className="top-search-wrap" ref={wrap}>
      <form className="top-search" role="search" onSubmit={(e) => e.preventDefault()}>
        <Search size="1.2em" aria-hidden />
        <input ref={inputRef} value={query} placeholder="Search pages" aria-label="Search pages" role="combobox" aria-expanded={open} aria-controls="notes-search-results"
          autoComplete="off" onChange={(e) => setQuery(e.target.value)} onFocus={show} onKeyDown={onKeyDown} />
        <kbd>Ctrl K</kbd>
      </form>
      {open && (
        <div className="search-panel" id="notes-search-results" onMouseDown={(e) => { if (!(e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
          <Filters notebooks={notebooks.data ?? []} />
          {scanning && <p className="muted small pad">Still indexing, so some pages may be missing.</p>}
          {meaning && <SemanticHint state={how ?? "off"} />}
          {!asked && <p className="muted small pad">Type to search the pages of your notebooks, or pick a filter.</p>}
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
                {g.id === "memory" && <button className="link small" onClick={() => { close(); go({ page: "memory", q: settled.trim() }); }}>Show all in Memory</button>}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
