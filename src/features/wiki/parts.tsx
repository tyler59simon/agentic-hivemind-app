// The pieces the wiki's pages are built from: navigation context, rows, infobox, contents and the Markdown body.
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookOpen, FileText, Folder, Package } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WikiNote, WikiPageSource } from "../../lib/lm";
import { typeClass } from "../../lib/noteTypes";
import { ArrowLink, Row, Section } from "../../ui/Page";
import { HoverPreview } from "../preview/HoverPreview";
import { remarkWikilinks, WIKI_PREFIX } from "../viewer/remarkWikilinks";
import { citeIndex, citeLinks, CITE_PREFIX, noteAt, pageStatus, resolveLink, shortTitle, sourceState, type WikiIndex } from "./wiki";
import { scrollBehavior } from "../../lib/motion";

interface Nav { ix: WikiIndex; goTo: (at: string) => void }
const NavContext = createContext<Nav | null>(null);
export const NavProvider = NavContext.Provider;
export const useNav = () => {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav outside the wiki");
  return nav;
};

/** A note type's badge; a page of the agent-written edition (type "article") has its own colour. */
export const TypeBadge = ({ type }: { type: string }) => <span className={`badge ${type === "article" ? "type-article" : typeClass(type)}`}>{type}</span>;
/** Where an agent-written page stands: planned (not written yet) or stale (a source changed). A current page has no mark. */
export function PageFlag({ note }: { note: WikiNote }) {
  const status = pageStatus(note);
  if (!note.page || status === "current") return null;
  return status === "stale"
    ? <span className="status-chip warn" title="A source of this page changed since it was written">stale</span>
    : <span className="badge" title="Planned by the outline, not written yet">planned</span>;
}
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A note's list row: type, status when retired, where it lives, date and the start of its lead. */
export function NoteRow({ n, where, file, noLead }: { n: WikiNote; where?: boolean; file?: boolean; noLead?: boolean }) {
  const { ix, goTo } = useNav();
  const project = ix.projects.get(n.project), section = ix.sections.get(n.section);
  const Icon = n.filename ? FileText : BookOpen;
  return (
    <li>
      <button className="lib-row" onClick={() => goTo(noteAt(n))}>
        <Icon size="1.3em" aria-hidden />
        <span className="lib-row-main">
          <span className="lib-row-title">{file && n.filename ? <span className="mono">{n.filename}</span> : shortTitle(n)}</span>
          <span className="lib-row-meta">
            <TypeBadge type={n.type} />
            {n.page && <PageFlag note={n} />}
            {n.retired && <span>{n.status}</span>}
            {where && <span>{section ? `${project?.name} › ${section.label}` : "Source note"}</span>}
            {file && n.filename && <span>{shortTitle(n)}</span>}
            <span>{n.updated}</span>
          </span>
          {n.lead && !noLead && <span className="lib-row-text">{n.lead}</span>}
        </span>
      </button>
    </li>
  );
}

export function NoteRows({ notes, ...opts }: { notes: WikiNote[]; where?: boolean; file?: boolean; noLead?: boolean }) {
  return notes.length
    ? <ol className="lib-list">{notes.map((n) => <NoteRow key={n.id} n={n} {...opts} />)}</ol>
    : <p className="muted">Nothing here yet.</p>;
}

/** A link row to a page: a type badge or an icon, the label and a count. */
export function PageRow({ at, label, icon, count, type }: { at: string; label: string; icon?: "folder" | "file" | "box"; count?: number; type?: string }) {
  const { goTo } = useNav();
  const Icon = icon === "folder" ? Folder : icon === "box" ? Package : FileText;
  return <Row onClick={() => goTo(at)} icon={type ? <TypeBadge type={type} /> : icon ? <Icon size="1.2em" aria-hidden /> : undefined} meta={count}>{label}</Row>;
}

/** A section of a page: heading with a count, a blurb, then the content. `id` is where the contents list scrolls to. */
export function WikiSection({ id, title, count, blurb, children }: { id?: string; title: ReactNode; count?: number; blurb?: string; children: ReactNode }) {
  return (
    <div id={id} className="wiki-anchor">
      <Section title={title} count={count} className="wiki-section">
        {blurb && <p className="muted">{blurb}</p>}
        {children}
      </Section>
    </div>
  );
}

export function More({ at, children }: { at: string; children: ReactNode }) {
  const { goTo } = useNav();
  return <ArrowLink onClick={() => goTo(at)}>{children}</ArrowLink>;
}

/** The boxed summary beside an article: a title and label/value pairs; empty values are left out. */
export function Infobox({ title, icon, pairs, children }: { title: string; icon: ReactNode; pairs?: [string, ReactNode][]; children?: ReactNode }) {
  const shown = (pairs ?? []).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  return (
    <div className="wiki-infobox">
      <div className="wiki-infobox-head">{icon}{title}</div>
      {!!shown.length && <dl>{shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      {children}
    </div>
  );
}

export interface TocItem { id: string; text: string; num?: number; count?: number; sub?: boolean }

/** "On this page": scrolls to a section or heading. Open on wide screens, closed on narrow ones. */
export function Toc({ items }: { items: TocItem[] }) {
  return (
    <details className="wiki-toc" open={typeof window !== "undefined" && window.innerWidth > 1100}>
      <summary>On this page</summary>
      <ol>
        {items.map((it) => (
          <li key={it.id} className={it.sub ? "sub" : ""}>
            <a href={`#${it.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(it.id)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }); }}>
              {it.num != null && <span className="num">{it.num}</span>}
              <span>{it.text}</span>
              {it.count != null && <span className="n">{it.count}</span>}
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Markdown with [[links]] resolved against the wiki: a page here navigates inside the wiki, a note in another domain is marked
 *  as such, and a title nothing has is shown as unresolved. `inline` drops the paragraph wrapper (for a lead). Headings get
 *  an id from their line (`wiki-h-<line>`), which the contents list uses. With `sources` (an agent-written page's), `[^k]`
 *  is a superscript link to the k-th source note. */
export function WikiMarkdown({ children, inline, sources }: { children: string; inline?: boolean; sources?: WikiPageSource[] }) {
  const { ix, goTo } = useNav();
  const text = useMemo(() => (sources ? citeLinks(children, sources.length) : children), [children, sources]);
  const components = useMemo<Components>(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] =>
      ({ node, children: c }) => <Tag id={`wiki-h-${(node?.position?.start.line ?? 1) - 1}`}>{c}</Tag>;
    return {
      a: ({ href, children: label }) => {
        const k = citeIndex(href);
        if (k !== null) {
          const source = sources?.[k - 1], state = source && sourceState(source), target = source && ix.refs.get(source.ref);
          const title = source ? `${source.title}${state === "changed" ? " (changed since this page was written)" : state === "removed" ? " (removed)" : ""}` : undefined;
          return (
            <sup className="wiki-cite">
              {target
                ? <HoverPreview refId={`${ix.model.domain}:${target.id}`}><a href={`#${noteAt(target)}`} className={state === "current" ? undefined : state} title={title} onClick={(e) => { e.preventDefault(); goTo(noteAt(target)); }}>{label}</a></HoverPreview>
                : <span className={state === "current" ? undefined : state} title={title}>{label}</span>}
            </sup>
          );
        }
        if (href?.startsWith(WIKI_PREFIX)) {
          const target = resolveLink(ix, decodeURIComponent(href.slice(WIKI_PREFIX.length)));
          if (target.kind === "note") {
            const n = target.note;
            return (
              <HoverPreview refId={`${ix.model.domain}:${n.id}`}>
                <a href={`#${noteAt(n)}`} className={`wikilink ${n.retired ? "retired" : ""}`} title={`${n.type}: ${n.title}`}
                  onClick={(e) => { e.preventDefault(); goTo(noteAt(n)); }}>{label}</a>
              </HoverPreview>
            );
          }
          if (target.kind === "external") {
            return <span className="wikilink external" title={`In the ${target.domain} domain, not part of this wiki`}>{label}<small>{target.domain}</small></span>;
          }
          return <span className="wikilink unresolved" title="No page has this title yet">{label}</span>;
        }
        return <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined); }}>{label}</a>;
      },
      ...(inline ? { p: ({ children: c }) => <>{c}</> } : {}),
      h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
    };
  }, [ix, goTo, inline, sources]);
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkWikilinks]} components={components} urlTransform={(url) => (url.startsWith(WIKI_PREFIX) || url.startsWith(CITE_PREFIX) ? url : defaultUrlTransform(url))}>
      {text}
    </Markdown>
  );
}
