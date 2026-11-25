// The pages of the agent-written edition: the contents page with the build's details, and one article per page with its
// citations, Sources list and details. They are built from the same parts as the structured wiki's pages.
import { Package } from "lucide-react";
import { useMemo } from "react";
import type { WikiNote, WikiPageSource } from "../../lib/lm";
import { outline } from "../../lib/note";
import { PageHeader, Row, Split } from "../../ui/Page";
import { Infobox, PageFlag, Toc, TypeBadge, WikiMarkdown, WikiSection as Sec, useNav, type TocItem } from "./parts";
import { agentSections, neighbours, noteAt, pageCounts, pageStatus, sectionAt, sourceState, usd } from "./wiki";

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/** The contents page: the sections with their pages (planned ones marked), what the outline left out, and the build's details. */
export function AgentMainPage() {
  const { ix, goTo } = useNav();
  const m = ix.model, project = m.projects[0], build = m.build;
  const sections = agentSections(ix), counts = pageCounts(m.notes);
  const omitted = build?.omitted ?? [];
  return (
    <>
      <PageHeader eyebrow={`${m.domain} · agent-written wiki`} title={project?.name ?? m.domain}
        subtitle={project?.description || "An agent read the notes of this scope and arranged them into the sections below."} />
      {build && !build.complete && (
        <div className="wiki-banner">The build stopped before every page was written. Refresh continues from where it stopped.</div>
      )}
      <Split label="Build details" rail={
        <Infobox title="Build" icon={<Package size="1.2em" aria-hidden />} pairs={[
          ["Scope", m.scope === "domain" || !m.scope ? "Whole domain" : `Project ${m.scope}`],
          ["Sections", String(sections.length)],
          ["Pages", `${counts.pages}: ${counts.written} written${counts.planned ? `, ${counts.planned} planned` : ""}${counts.stale ? `, ${counts.stale} stale` : ""}`],
          ["Left out", omitted.length ? String(omitted.length) : null],
          ["Model", build?.model], ["Cost", build ? usd(build.cost_usd) : null], ["Built", day(build?.built)],
        ]} />
      }>
        {sections.length ? (
          <div className="wiki-portals">
            {sections.map(({ section, pages }) => (
              <div key={section.key} className="wiki-portal">
                <h3><button className="text" onClick={() => goTo(sectionAt(project.slug, section.key))}>{section.label}</button></h3>
                {section.blurb && <p>{section.blurb}</p>}
                <div className="wiki-links">
                  {pages.map((n) => (
                    <Row key={n.id} onClick={() => goTo(noteAt(n))} meta={<PageFlag note={n} />}>{n.title}</Row>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted">This edition has no pages yet.</p>}
        {!!omitted.length && (
          <Sec title="Left out" count={omitted.length} blurb="The outline call may leave notes out when they would mislead a reader.">
            <ul className="wiki-omitted">
              {omitted.map((o) => {
                const note = ix.notes.get(o.id);
                return (
                  <li key={o.id}>
                    {note ? <a href={`#${noteAt(note)}`} onClick={(e) => { e.preventDefault(); goTo(noteAt(note)); }}>{o.title}</a> : o.title}
                    <span className="muted">{o.reason}</span>
                  </li>
                );
              })}
            </ul>
          </Sec>
        )}
      </Split>
    </>
  );
}

/** The numbered Sources list of a page: each cited note, marked when it changed since the page was written or was removed. */
function SourceList({ sources, planned }: { sources: WikiPageSource[]; planned: boolean }) {
  const { ix, goTo } = useNav();
  return (
    <Sec id="sources" title={planned ? "Planned sources" : "Sources"} count={sources.length}>
      <ol className="wiki-sources">
        {sources.map((s) => {
          const state = sourceState(s), note = ix.refs.get(s.ref);
          return (
            <li key={s.id}>
              {note ? <a href={`#${noteAt(note)}`} onClick={(e) => { e.preventDefault(); goTo(noteAt(note)); }}>{s.title}</a> : <span>{s.title}</span>}
              <span className="wiki-source-meta">
                <TypeBadge type={s.type} />
                {state === "changed" && <span className="status-chip warn" title="Its revision moved on after this page was written">changed</span>}
                {state === "removed" && <span className="status-chip bad" title="It was archived or deleted">removed</span>}
                {note && <span>updated {note.updated}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </Sec>
  );
}

/** One page: a written article with citations and Sources, or a planned page with its purpose and planned sources. */
export function AgentPage({ note: n }: { note: WikiNote }) {
  const { ix, goTo } = useNav();
  const info = n.page!, status = pageStatus(n), section = ix.sections.get(n.section);
  const { prev, next } = neighbours(ix, n);
  const toc = useMemo<TocItem[]>(() => [
    ...(info.written ? outline(n.body).map((h) => ({ text: h.text, id: `wiki-h-${h.line}`, sub: h.level >= 3 })) : []),
    { text: info.written ? "Sources" : "Planned sources", id: "sources" },
  ], [n.body, info.written]);
  return (
    <>
      <PageHeader eyebrow={section?.label} title={n.title} meta={<PageFlag note={n} />} />
      {status === "planned" && <div className="wiki-banner">This page is planned and not written yet. A build writes it from the notes listed under Planned sources.</div>}
      {status === "stale" && <div className="wiki-banner">A source of this page changed or was removed since it was written. Refresh the wiki to rewrite it.</div>}
      <Split label="Page details" rail={<>
        <Infobox title="Page details" icon={<Package size="1.2em" aria-hidden />} pairs={[
          ["Status", status === "planned" ? "Planned" : status === "stale" ? "Written, stale" : "Written, current"],
          ["Section", section ? <a key="x" href={`#${sectionAt(n.project, n.section)}`} onClick={(e) => { e.preventDefault(); goTo(sectionAt(n.project, n.section)); }}>{section.label}</a> : null],
          ["Sources", String(info.sources.length)], ["Built", day(info.built)], ["Model", info.model], ["Cost", info.written ? usd(info.cost_usd) : null],
          ["Style notes", info.warnings.length ? String(info.warnings.length) : null],
        ]} />
        <Toc items={toc} />
      </>}>
        <p className="wiki-lead"><WikiMarkdown inline sources={info.sources}>{n.lead}</WikiMarkdown></p>
        {info.written && <div className="markdown wiki-body"><WikiMarkdown sources={info.sources}>{n.body}</WikiMarkdown></div>}
        <SourceList sources={info.sources} planned={!info.written} />
        {!!info.warnings.length && (
          <details className="wiki-warnings">
            <summary>Style notes ({info.warnings.length})</summary>
            <ul>{info.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
        {(prev || next) && (
          <nav className="wiki-pager" aria-label="Previous and next page">
            {prev && <button className="prev" onClick={() => goTo(noteAt(prev))}><small>Previous</small><span>{prev.title}</span></button>}
            {next && <button className="next" onClick={() => goTo(noteAt(next))}><small>Next</small><span>{next.title}</span></button>}
          </nav>
        )}
      </Split>
    </>
  );
}

/** Pages that cite a source note, for the source note's own page. */
export function CitedOn({ pages }: { pages: WikiNote[] }) {
  const { goTo } = useNav();
  return (
    <Sec id="cited-on" title="Cited on" count={pages.length}>
      <div className="wiki-links">{pages.map((n) => <Row key={n.id} onClick={() => goTo(noteAt(n))} meta={<PageFlag note={n} />}>{n.title}</Row>)}</div>
    </Sec>
  );
}
