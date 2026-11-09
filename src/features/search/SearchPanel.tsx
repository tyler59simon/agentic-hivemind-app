import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NOTE_TYPES, search, STATUSES, taxonomy, type NoteType, type SearchOptions, type Status } from "../../lib/lm";
import { highlight, shortDate, terms } from "../../lib/text";
import { useApp } from "../../store";

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const t = setTimeout(() => setSettled(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return settled;
}

function Marked({ text, words }: { text: string; words: string[] }) {
  return <>{highlight(text, words).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

export function SearchPanel() {
  const { domain, open, selected } = useApp();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchOptions["scope"]>("fallback");
  const [type, setType] = useState<NoteType | undefined>();
  const [status, setStatus] = useState<Status | undefined>();
  const [tag, setTag] = useState<string | undefined>();
  const settled = useDebounced(query.trim(), 250);
  const tags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const results = useQuery({
    queryKey: ["search", domain, settled, scope, type, status, tag],
    queryFn: () => search({ query: settled, domain: domain!, scope, type, status, tag }),
    enabled: !!domain && !!settled,
  });
  const words = terms(settled);
  const chip = <T extends string>(value: T, current: T | undefined, set: (v: T | undefined) => void) => (
    <button key={value} className={`chip ${current === value ? "on" : ""}`} onClick={() => set(current === value ? undefined : value)}>{value}</button>
  );

  return (
    <section className="search">
      <input autoFocus className="search-input" placeholder="Search notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="facets">
        <select value={scope} onChange={(e) => setScope(e.target.value as SearchOptions["scope"])} aria-label="Scope">
          <option value="fallback">Domain + global</option>
          <option value="active">Domain only</option>
          <option value="all">All domains</option>
        </select>
        <select value={tag ?? ""} onChange={(e) => setTag(e.target.value || undefined)} aria-label="Tag">
          <option value="">Any tag</option>
          {tags.data?.tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="chips">{NOTE_TYPES.map((t) => chip(t, type, setType))}</div>
      <div className="chips">{STATUSES.map((s) => chip(s, status, setStatus))}</div>
      {results.error && <p className="error">{String(results.error)}</p>}
      {results.data && (
        <p className="muted">
          {results.data.results.length} result{results.data.results.length === 1 ? "" : "s"}
          {results.data.fallback && " (from other domains: nothing matched here)"}
        </p>
      )}
      <ol className="results">
        {results.data?.results.map((hit) => {
          const ref = `${hit.domain}:${hit.id}`;
          return (
            <li key={ref}>
              <button className={`result ${selected === ref ? "on" : ""}`} onClick={() => open(ref)}>
                <span className="result-title"><Marked text={hit.title} words={words} /></span>
                <span className="result-meta">
                  <span className={`badge type-${hit.type}`}>{hit.type}</span>
                  {hit.domain !== domain && <span className="tag">{hit.domain}</span>}
                  {hit.status !== "active" && <span className={`badge status-${hit.status}`}>{hit.status}</span>}
                  <span className="muted">{shortDate(hit.updated)}</span>
                </span>
                <span className="snippet"><Marked text={hit.snippet} words={words} /></span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
