// One component per kind of wiki page, laid out like the exported file: a header, the page body, and an infobox and
// contents list in the rail.
import { Package } from "lucide-react";
import { useMemo } from "react";
import type { WikiFolder, WikiNote, WikiProject, WikiSection } from "../../lib/lm";
import { outline } from "../../lib/note";
import { useWorkspace } from "../../workspace/store";
import { PageHeader, Split } from "../../ui/Page";
import { Infobox, More, NoteRows, PageRow, Toc, TypeBadge, WikiMarkdown, WikiSection as Sec, cap, plural, useNav, type TocItem } from "./parts";
import { CitedOn } from "./agent";
import { azGroups, byUpdated, CHRONO, citedOn, dayGroups, isAgent, isSource, monthGroups, neighbours, noteAt, pathPrefix, projectAt, sectionAt, sectionNotes, shortTitle } from "./wiki";

const Lead = ({ note, children }: { note: WikiNote; children?: React.ReactNode }) => (
  <div className="wiki-lead-block">
    <p className="wiki-lead"><WikiMarkdown inline>{note.lead}</WikiMarkdown></p>
    {children}
  </div>
);

const Mono = ({ text }: { text: string }) => <span className="mono">{text}</span>;
const PathLine = ({ text }: { text: string }) => <span className="wiki-path">{text}</span>;

export function MainPage() {
  const { ix, goTo } = useNav();
  const m = ix.model;
  const start = m.projects.flatMap((p) => [...p.briefs, ...p.maps]).map((id) => ix.notes.get(id)).filter((n): n is WikiNote => !!n);
  return (
    <>
      <PageHeader eyebrow={`${m.domain} · wiki`} title={`${cap(m.domain)} wiki`} meta={`Generated ${m.generated}`}
        subtitle={`The working memory of the ${m.domain} domain, organised by project. Open a project for its overview, decisions, guides and code reference, or search every page.`} />
      <Sec title="Projects" count={m.projects.length}>
        {m.projects.length ? (
          <div className="wiki-portals">
            {m.projects.map((p) => (
              <div key={p.slug} className="wiki-portal">
                <h3><button className="text" onClick={() => goTo(projectAt(p.slug))}>{p.name}</button></h3>
                {p.description && <p>{p.description}</p>}
                <span className="muted small">{plural(p.count, "page")}{p.updated ? ` · updated ${p.updated}` : ""}</span>
                <div className="wiki-portal-links">
                  {m.sections.filter((s) => p.sections[s.key]).map((s) => (
                    <button key={s.key} className="wiki-chip" onClick={() => goTo(sectionAt(p.slug, s.key))}>{s.label}<span className="n">{p.sections[s.key].count}</span></button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted">This domain has no notes yet.</p>}
      </Sec>
      <Split rail={<>
        {!!start.length && <Infobox title="Start here" icon={<Package size="1.2em" aria-hidden />}>
          <div className="wiki-links">{start.map((n) => <PageRow key={n.id} at={noteAt(n)} label={n.title} type={n.type} />)}</div>
        </Infobox>}
        <Infobox title="Browse" icon={<Package size="1.2em" aria-hidden />}>
          <div className="wiki-links">
            <PageRow at="az" label="A to Z index" count={m.notes.length} />
            <PageRow at="recent" label="Recent changes" />
          </div>
        </Infobox>
      </>}>
        <Sec title="Recently updated" blurb="The ten pages changed most recently, across every project.">
          <NoteRows notes={byUpdated(m.notes).slice(0, 10)} where />
          <More at="recent">All recent changes</More>
        </Sec>
      </Split>
    </>
  );
}

export function ProjectPage({ project: p }: { project: WikiProject }) {
  const { ix } = useNav();
  const m = ix.model;
  const lead = (p.charter ? ix.notes.get(p.charter) : undefined) ?? (p.briefs[0] ? ix.notes.get(p.briefs[0]) : undefined);
  const shown = m.sections.filter((s) => p.sections[s.key]);
  const toc: TocItem[] = shown.map((s, i) => ({ num: i + 1, text: s.label, id: `sec-${s.key}`, count: p.sections[s.key].count }));
  const links = (ids: string[]) => ids.map((id) => ix.notes.get(id)).filter((n): n is WikiNote => !!n).map((n) => <NoteLink key={n.id} n={n} text={n.title} />);
  return (
    <>
      <PageHeader eyebrow="Project" title={p.name} subtitle={p.description} />
      <Split rail={<>
        <Infobox title={p.name} icon={<Package size="1.2em" aria-hidden />} pairs={[
          ["Aliases", p.aliases.join(", ")], ["Status", p.status], ["Repositories", p.repos.map((r) => <Mono key={r} text={r} />)],
          ["Pages", String(p.count)], ["Updated", p.updated], ["Charter", p.charter ? links([p.charter]) : null], ["Brief", links(p.briefs)], ["Code maps", links(p.maps)],
        ]} />
        {!!toc.length && <Toc items={toc} />}
      </>}>
        {lead?.lead && <Lead note={lead}><More at={noteAt(lead)}>Read the {lead.type === "brief" ? "project brief" : "charter"}</More></Lead>}
        {shown.map((s) => {
          const x = p.sections[s.key], limit = s.key === "overview" || s.key === "architecture" ? 8 : 5;
          if (s.key === "code") {
            return (
              <Sec key={s.key} id={`sec-${s.key}`} title={s.label} count={x.count} blurb={s.blurb}>
                <div className="wiki-links">{(x.folders ?? []).map((id) => ix.folders.get(id)).filter((f): f is WikiFolder => !!f).map((f) => <PageRow key={f.id} at={f.id} label={f.name} icon="folder" count={f.count} />)}</div>
              </Sec>
            );
          }
          const notes = sectionNotes(ix, p, s.key);
          return (
            <Sec key={s.key} id={`sec-${s.key}`} title={s.label} count={x.count} blurb={s.blurb}>
              <NoteRows notes={notes.slice(0, limit)} />
              {notes.length > limit && <More at={sectionAt(p.slug, s.key)}>All {notes.length} {s.label.toLowerCase()}</More>}
            </Sec>
          );
        })}
      </Split>
    </>
  );
}

function NoteLink({ n, text }: { n: WikiNote; text: string }) {
  const { goTo } = useNav();
  return <a href={`#${noteAt(n)}`} onClick={(e) => { e.preventDefault(); goTo(noteAt(n)); }}>{text}</a>;
}

export function SectionPage({ project: p, section }: { project: WikiProject; section: WikiSection }) {
  const { ix } = useNav();
  const x = p.sections[section.key];
  const notes = sectionNotes(ix, p, section.key);
  const groups = useMemo(() => (CHRONO.has(section.key) ? monthGroups(notes) : null), [notes, section.key]);
  return (
    <>
      <PageHeader eyebrow={p.name} title={section.label} subtitle={section.blurb} />
      {section.key === "code" ? (x.folders ?? []).map((id) => ix.folders.get(id)).filter((f): f is WikiFolder => !!f).map((f) => (
        <Sec key={f.id} title={f.name} count={f.count}>
          <div className="wiki-links">
            {f.folders.map((c) => ix.folders.get(c)).filter((c): c is WikiFolder => !!c).map((c) => <PageRow key={c.id} at={c.id} label={c.name} icon="folder" count={c.count} />)}
            {!!f.notes.length && <PageRow at={f.id} label={`Pages in ${f.name}`} icon="file" count={f.notes.length} />}
          </div>
        </Sec>
      )) : groups ? groups.map((g) => <Sec key={g.label} title={g.label} count={g.notes.length}><NoteRows notes={g.notes} /></Sec>) : <NoteRows notes={notes} />}
    </>
  );
}

export function FolderPage({ folder: f }: { folder: WikiFolder }) {
  const { ix } = useNav();
  const p = ix.projects.get(f.project);
  const all = f.notes.map((id) => ix.notes.get(id)).filter((n): n is WikiNote => !!n);
  const docs = all.filter((n) => !n.filename), files = all.filter((n) => n.filename);
  return (
    <>
      <PageHeader eyebrow={`${p?.name} · code reference`} title={f.name} meta={<PathLine text={`${f.path}/`} />} />
      {!!docs.length && <Sec title="About this folder"><NoteRows notes={docs} /></Sec>}
      {!!f.folders.length && (
        <Sec title="Folders" count={f.folders.length}>
          <div className="wiki-links">{f.folders.map((id) => ix.folders.get(id)).filter((c): c is WikiFolder => !!c).map((c) => <PageRow key={c.id} at={c.id} label={c.name} icon="folder" count={c.count} />)}</div>
        </Sec>
      )}
      {!!files.length && <Sec title="Files" count={files.length}><NoteRows notes={files} file /></Sec>}
      {!all.length && !f.folders.length && <p className="muted">Nothing here yet.</p>}
    </>
  );
}

export function NotePage({ note: n }: { note: WikiNote }) {
  const { ix, goTo } = useNav();
  const p = ix.projects.get(n.project), section = ix.sections.get(n.section);
  const { prev, next } = neighbours(ix, n);
  const path = pathPrefix(n) || (n.section === "code" ? n.files[0] ?? "" : "");
  // In the agent edition a cited note lives in the hidden sources section; its page lists where it is cited.
  const cited = useMemo(() => (isAgent(ix.model) && isSource(n) ? citedOn(ix, n) : []), [ix, n]);
  const toc = useMemo<TocItem[]>(() => [
    ...outline(n.body).map((h) => ({ text: h.text, id: `wiki-h-${h.line}`, sub: h.level >= 3 })),
    ...(cited.length ? [{ text: "Cited on", id: "cited-on" }] : []),
    { text: "See also", id: "see-also" },
  ], [n.body, cited]);
  const openNote = () => useWorkspace.getState().openNote(`${ix.model.domain}:${n.id}`, { title: n.title });
  const related = (title: string, ids: string[]) => {
    const notes = ids.map((id) => ix.notes.get(id)).filter((m): m is WikiNote => !!m);
    return (
      <div>
        <h3>{title} ({ids.length})</h3>
        <div className="wiki-links">{notes.length ? notes.map((m) => <PageRow key={m.id} at={noteAt(m)} label={shortTitle(m)} type={m.type} />) : <span className="muted">None</span>}</div>
      </div>
    );
  };
  return (
    <>
      <PageHeader eyebrow={isSource(n) ? "Source note" : `${p?.name} · ${section?.label}`} title={shortTitle(n)} meta={path ? <PathLine text={path} /> : undefined}
        actions={<button className="outline" onClick={openNote}>Open note</button>} />
      {n.retired && <div className="wiki-banner">This page is {n.status}. It is kept for history and may be out of date.</div>}
      <Split rail={<>
        <Infobox title="Page details" icon={<Package size="1.2em" aria-hidden />} pairs={[
          ["Type", <TypeBadge key="t" type={n.type} />], ["Status", <span key="s" className={`status-chip ${n.retired ? "warn" : "active"}`}>{n.status}</span>],
          ["Project", p ? <a key="p" href={`#${projectAt(p.slug)}`} onClick={(e) => { e.preventDefault(); goTo(projectAt(p.slug)); }}>{p.name}</a> : null],
          ["Section", p && section ? <a key="x" href={`#${sectionAt(p.slug, n.section)}`} onClick={(e) => { e.preventDefault(); goTo(sectionAt(p.slug, n.section)); }}>{section.label}</a> : null],
          ["Updated", n.updated], ["Created", n.created], ["Files", n.files.map((f) => <Mono key={f} text={f} />)],
          ["Tags", n.tags.length ? <span key="g" className="tags">{n.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span> : null],
          ["Ref", <Mono key="r" text={`${ix.model.domain}:${n.ref}`} />],
        ]} />
        <Toc items={toc} />
      </>}>
        {n.lead && <Lead note={n} />}
        <div className="markdown wiki-body"><WikiMarkdown>{n.body}</WikiMarkdown></div>
        {!!cited.length && <CitedOn pages={cited} />}
        <Sec id="see-also" title="See also">
          <div className="wiki-see-also">{related("Links to", n.out)}{related("Linked from", n.backlinks)}</div>
        </Sec>
        {(prev || next) && (
          <nav className="wiki-pager" aria-label="Previous and next page">
            {prev && <button className="prev" onClick={() => goTo(noteAt(prev))}><small>Previous</small><span>{shortTitle(prev)}</span></button>}
            {next && <button className="next" onClick={() => goTo(noteAt(next))}><small>Next</small><span>{shortTitle(next)}</span></button>}
          </nav>
        )}
      </Split>
    </>
  );
}

export function AzPage() {
  const { ix } = useNav();
  const groups = useMemo(() => azGroups(ix.model.notes), [ix]);
  return (
    <>
      <PageHeader eyebrow="Browse" title="A to Z index" subtitle={`${plural(ix.model.notes.length, "page")} in alphabetical order.`} />
      <div className="wiki-letters">
        {groups.map((g) => <button key={g.letter} type="button" onClick={() => document.getElementById(`az-${g.letter}`)?.scrollIntoView({ behavior: "smooth" })}>{g.letter}</button>)}
      </div>
      {groups.map((g) => <Sec key={g.letter} id={`az-${g.letter}`} title={g.letter} count={g.notes.length}><NoteRows notes={g.notes} where noLead /></Sec>)}
    </>
  );
}

export function RecentPage() {
  const { ix } = useNav();
  const days = useMemo(() => dayGroups(ix.model.notes), [ix]);
  return (
    <>
      <PageHeader eyebrow="Browse" title="Recent changes" subtitle="The 80 most recently updated pages, by day." />
      {days.map((d) => <Sec key={d.day} title={d.day || "Undated"}><NoteRows notes={d.notes} where noLead /></Sec>)}
    </>
  );
}

export function SearchPage({ query, hits }: { query: string; hits: WikiNote[] }) {
  return (
    <>
      <PageHeader eyebrow="Search" title={`“${query}”`} subtitle={`${plural(hits.length, "page")} match. Title matches come first.`} />
      <NoteRows notes={hits} where />
    </>
  );
}

export function MissingPage({ at }: { at: string }) {
  return (
    <>
      <PageHeader eyebrow="Wiki" title="No such page" subtitle={`Nothing in this wiki has the address “${at}”. The page may be retired, or the wiki may have changed.`} />
      <More at="">Back to the main page</More>
    </>
  );
}
