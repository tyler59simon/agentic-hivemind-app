import { useQuery } from "@tanstack/react-query";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, Circle, CircleCheck, ExternalLink, FileText, Globe, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { viewRef, type ViewItem, type ViewModel, type ViewRow } from "../../lib/lm";
import { toast } from "../../ui/toast";
import { PageHeader, Tabs } from "../../ui/Page";
import { useWorkspace } from "../../workspace/store";
import { useNoteLinks, type NoteLinks } from "../links/useLinks";
import { WikiLink } from "../viewer/NoteView";
import { badgeClass, chipGroups, defaultTab, linkParts, liveTags, noteBanner, SORTS, tabCount, TABS, visibleItems, type Sort, type Tab } from "./dashboard";
import { DashMarkdown } from "./DashMarkdown";
import { viewModelQuery } from "./useDashboards";

/** A tag as a coloured badge. */
const Badge = ({ tag }: { tag: string }) => <span className={`status-chip ${badgeClass(tag)}`.trim()}>{tag}</span>;

const flip = <T,>(set: ReadonlySet<T>, v: T): Set<T> => { const next = new Set(set); if (!next.delete(v)) next.add(v); return next; };

function Card({ item, links, open, onToggle }: { item: ViewItem; links: NoteLinks | null; open: boolean; onToggle: () => void }) {
  const has = !!item.detail;
  const head = (
    <>
      <span className="work-mark" title={item.done ? "Done" : "Open"}>{item.done ? <CircleCheck size="1.3em" aria-hidden /> : <Circle size="1.3em" aria-hidden />}</span>
      <span className="work-main">
        {item.id && <span className="eyebrow">{item.id}</span>}
        <span className="work-text"><DashMarkdown inline links={links}>{item.text || item.id || "(no text)"}</DashMarkdown></span>
      </span>
      {!!item.tags.length && <span className="work-tags">{item.tags.map((t) => <Badge key={t} tag={t} />)}</span>}
      {has && <span className="work-more"><ChevronDown size="1.2em" aria-hidden /></span>}
    </>
  );
  return (
    <article className={`work-group${item.done ? " done" : ""}${has ? " has-detail" : ""}${open ? " expanded" : ""}`}>
      {has ? <button type="button" className="work-head" aria-expanded={open} onClick={onToggle}>{head}</button> : <div className="work-head">{head}</div>}
      {has && open && <div className="work-detail markdown"><DashMarkdown links={links}>{item.detail!}</DashMarkdown></div>}
    </article>
  );
}

/** The filter bar and the item cards. The filters live here, so another dashboard starts clean (the parent keys this on the ref). */
function Items({ model, links }: { model: ViewModel; links: NoteLinks | null }) {
  const [tab, setTab] = useState<Tab>(defaultTab(model.counts));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("written");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const groups = useMemo(() => chipGroups(model.items), [model.items]);
  const tags = useMemo(() => liveTags(model.items, picked), [model.items, picked]);
  const shown = useMemo(() => visibleItems(model.items, { tab, tags, q }, sort), [model.items, tab, tags, q, sort]);
  if (!model.items.length) return <p className="muted">This note has no action items.</p>;
  return (
    <>
      <div className="lib-bar">
        <Tabs label="Show items" value={tab} onChange={setTab} items={TABS.map((t) => ({ ...t, count: tabCount(model.counts, t.id) }))} />
        <label className="lib-search"><Search size="1.2em" aria-hidden /><input value={q} placeholder="Search items" aria-label="Search items" onChange={(e) => setQ(e.target.value)} /></label>
        <select value={sort} aria-label="Sort items" onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {!!groups.length && (
        <div className="chips">
          {groups.map((g, i) => (
            <span key={g.kind} className="chip-group">
              {i > 0 && <span className="chip-gap" aria-hidden />}
              {g.tags.map((t) => <button key={t} type="button" className={`chip${tags.has(t) ? " on" : ""}`} aria-pressed={tags.has(t)} onClick={() => setPicked(flip(picked, t))}>{t}</button>)}
            </span>
          ))}
        </div>
      )}
      <div className="work-list">
        {shown.map((it) => <Card key={it.index} item={it} links={links} open={expanded.has(it.index)} onToggle={() => setExpanded(flip(expanded, it.index))} />)}
        {!shown.length && <p className="muted">No items match the filters.</p>}
      </div>
    </>
  );
}

async function openHtml(path: string) {
  try { await openPath(path); }
  catch {
    navigator.clipboard?.writeText(path).catch(() => undefined);
    toast(`Could not open the page. Its path is copied: ${path}`, "warn");
  }
}

/** One dashboard: the header with its actions, then the note's state, progress, items and remaining sections.
 *  `list` is the page's view list, drawn beside the dashboard. */
export function DashboardView({ row, list }: { row: ViewRow; list: ReactNode }) {
  const ref = viewRef(row);
  const query = useQuery(viewModelQuery(ref));
  const { note: links } = useNoteLinks(ref);
  const model = query.data;
  const banner = model && noteBanner(model);
  const noteTitle = row.note_title ?? row.title ?? ref;
  const openNote = () => useWorkspace.getState().openNote(ref, { title: noteTitle });
  const actions = (
    <>
      <button className="outline" onClick={openNote} disabled={!row.note_title} title={row.note_title ? "Open the note in Memory" : "The note was not found"}><FileText size="1.15em" aria-hidden />Open note</button>
      <button className="outline" onClick={() => openHtml(row.path)} disabled={!row.exists} title={row.path}><Globe size="1.15em" aria-hidden />Open HTML</button>
      {row.artifact_url && <button className="outline" onClick={() => openUrl(row.artifact_url!).catch((e) => toast(classify(e).message, "error"))} title={row.artifact_url}><ExternalLink size="1.15em" aria-hidden />Open artifact</button>}
    </>
  );
  const sub = model?.summary && linkParts(model.summary).map((p, i) => "link" in p
    ? <WikiLink key={i} target={p.link} links={links}>{p.label}</WikiLink> : <span key={i}>{p.text}</span>);
  const { done, total } = model?.counts ?? { done: 0, total: 0 };
  return (
    <>
      <PageHeader eyebrow={model ? [model.domain, model.status === "missing" ? "" : model.type].filter(Boolean).join(" · ") : row.domain}
        title={model?.title || noteTitle} subtitle={sub || undefined} actions={actions} />
      <div className="split dash-split">
        <div className="split-main">{list}</div>
        <aside className="split-rail dash-body">
          {query.isLoading && <p className="muted">Loading…</p>}
          {query.error && <p className="error">{classify(query.error).message}</p>}
          {model && (
            <>
              {banner && <div className="banner warn" role="status">{banner}</div>}
              {model.important && <div className="banner"><span className="eyebrow">Important</span><div className="markdown"><DashMarkdown links={links}>{model.important}</DashMarkdown></div></div>}
              {!!total && (
                <div className="progress-line">
                  <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><span style={{ width: `${Math.round((100 * done) / total)}%` }} /></span>
                  <span className="muted small">{done} of {total} done</span>
                </div>
              )}
              <Items key={ref} model={model} links={links} />
              {model.sections.map((s) => (
                <section key={s.heading} className="section">
                  <h2>{s.heading}</h2>
                  <div className="markdown"><DashMarkdown links={links}>{s.text}</DashMarkdown></div>
                </section>
              ))}
              <p className="muted small dash-path" title="The local page, rewritten whenever the note changes">{row.path}</p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
