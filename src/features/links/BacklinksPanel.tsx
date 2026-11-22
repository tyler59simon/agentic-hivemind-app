// The page rail's Backlinks and Outgoing links for a page of a folder notebook (NS-4A). The index says which links are
// written with a name like this page's; the resolver (`resolve.ts`) says which of them really reach it, so the panel
// agrees with what a click on the link does. A link to a page that does not exist offers Create page.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
import { notebooksQuery, pageTitle, treeQuery } from "../../lib/notebooks";
import { INDEX_KEY, linksQuery, marked, pagesQuery, type IncomingLink, type IndexedPage, type Mention, type OutgoingLink } from "../../lib/noteindex";
import { toast } from "../../ui/toast";
import { createMissingPage, openPage } from "../notes/actions";
import { buildEnv, memoryNotesQuery } from "./env";
import { openMemoryNote, useFollowLink } from "./follow";
import { pagePart, resolveWritten, samePage, type PageEnv } from "./resolve";

const PAGE_EXTENSIONS = ["md", "markdown", "hmdoc", "txt", "canvas"];
/** A link to a picture or another file that is not a page is not an outgoing page link. */
function namesAPage(raw: string) {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(raw.split(/[#^?|]/)[0].trim())?.[1]?.toLowerCase();
  return !ext || PAGE_EXTENSIONS.includes(ext);
}

/** The resolver's world for the panel: notebooks, indexed pages and memory notes, kept up to date with the index. */
export function usePageEnv(): { env: PageEnv | null; pages: IndexedPage[] } {
  const notebooks = useQuery(notebooksQuery());
  const pages = useQuery(pagesQuery());
  const notes = useQuery({ ...memoryNotesQuery(), staleTime: 60_000 });
  const env = useMemo(() => (notebooks.data && pages.data ? buildEnv(notebooks.data, pages.data, (notes.data?.notes ?? []).map((n) => ({ ref: n.ref, title: n.title, domain: n.domain }))) : null), [notebooks.data, pages.data, notes.data]);
  return { env, pages: pages.data ?? [] };
}

export interface BackRow { notebook: string; path: string; title: string; lines: { line: number; context: string }[] }

/** The links the resolver sends to `file`, grouped by the page that wrote them. */
export function confirmBacklinks(file: FileRef, incoming: IncomingLink[], env: PageEnv, titles: Map<string, string>): BackRow[] {
  const rows = new Map<string, BackRow>();
  for (const link of incoming) {
    const at = { notebook: link.notebook, path: link.path };
    const hit = resolveWritten(link, at, env);
    if (!("ref" in hit) || !samePage(hit.ref, file)) continue;
    const key = `${link.notebook}\n${link.path}`;
    const row = rows.get(key) ?? { notebook: link.notebook, path: link.path, title: titles.get(key) ?? pageTitle(link.path), lines: [] };
    row.lines.push({ line: link.line, context: link.context });
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Both sections' data: the index's answer for this page and the resolver's world. */
function usePageLinks(file: FileRef) {
  const links = useQuery(linksQuery(file.notebook, file.path));
  const { env, pages } = usePageEnv();
  const titles = useMemo(() => new Map(pages.map((p) => [`${p.notebook}\n${p.path}`, p.title])), [pages]);
  return { links: links.data, loading: links.isLoading || !env, env, titles };
}

const open = (ref: FileRef, e: { ctrlKey: boolean; metaKey: boolean }) => openPage(ref, { split: e.ctrlKey || e.metaKey });

function Snippet({ text }: { text: string }) {
  return <>{marked(text).map((p, i) => (p.on ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

/** Linked and unlinked mentions of the page. */
export function Backlinks({ file }: { file: FileRef }) {
  const { links, loading, env, titles } = usePageLinks(file);
  const linked = useMemo(() => (links && env ? confirmBacklinks(file, links.incoming, env, titles) : []), [links, env, file, titles]);
  if (loading || !links) return <p className="muted pad">Loading…</p>;
  // A page that links here is not also an unlinked mention.
  const seen = new Set(linked.map((r) => `${r.notebook}\n${r.path}`));
  const mentions: Mention[] = links.unlinked.filter((m) => !seen.has(`${m.notebook}\n${m.path}`));
  return (
    <div className="links-panel">
      <section className="links-section">
        <h4>Linked <span className="muted">{linked.length}</span></h4>
        {linked.length ? linked.map((r) => (
          <button key={`${r.notebook}:${r.path}`} className="back-row" onClick={(e) => open({ notebook: r.notebook, path: r.path }, e)} title={r.path}>
            <span className="back-title">{r.title}{r.notebook !== file.notebook && <span className="muted small"> · {r.path}</span>}</span>
            {r.lines.slice(0, 2).map((l, i) => <span key={i} className="back-context muted small">{l.context}</span>)}
            {r.lines.length > 2 && <span className="muted small">and {r.lines.length - 2} more</span>}
          </button>
        )) : <p className="muted small">No page links here yet.</p>}
      </section>
      <section className="links-section">
        <h4>Unlinked mentions <span className="muted">{mentions.length}</span></h4>
        {mentions.length ? mentions.map((m) => (
          <button key={`${m.notebook}:${m.path}`} className="back-row" onClick={(e) => open({ notebook: m.notebook, path: m.path }, e)} title={m.path}>
            <span className="back-title">{m.title}</span>
            <span className="back-context muted small"><Snippet text={m.snippet} /></span>
          </button>
        )) : <p className="muted small">No other page uses this page's name.</p>}
      </section>
    </div>
  );
}

interface OutRow { link: OutgoingLink; name: string; result: ReturnType<typeof resolveWritten> }

/** The page's links, each with where it points; a link to a page that does not exist offers Create page. */
export function OutgoingLinks({ file }: { file: FileRef }) {
  const client = useQueryClient();
  const { links, loading, env } = usePageLinks(file);
  const own = useQuery(treeQuery(file.notebook));
  const ownPages = useMemo(() => (own.data?.entries ?? []).filter((e) => e.kind !== "dir").map((e) => e.path), [own.data]);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const follow = useFollowLink(file, ownPages, setDialog);
  const rows = useMemo<OutRow[]>(() => {
    if (!links || !env) return [];
    const seen = new Set<string>();
    const out: OutRow[] = [];
    for (const link of links.outgoing) {
      const name = link.kind === "wiki" ? pagePart(link.raw) : link.raw.split(/[#?]/)[0];
      if (!name) continue;
      const result = resolveWritten(link, file, env, ownPages.length ? ownPages : undefined);
      // A picture or another file a page shows is not a page it links to.
      if ("missing" in result && !namesAPage(name)) continue;
      // Two links to one page are one row.
      const key = "ref" in result ? `ref:${result.ref.notebook}:${result.ref.path}` : "note" in result ? `note:${result.note.ref}`
        : "missing" in result ? `missing:${result.missing}` : `${link.kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ link, name, result });
    }
    return out;
  }, [links, env, file, ownPages]);
  if (loading || !links) return <p className="muted pad">Loading…</p>;
  const create = (missing: string) => createMissingPage(file.notebook, missing).then(() => {
    client.invalidateQueries({ queryKey: ["notebook-tree", file.notebook] });
    client.invalidateQueries({ queryKey: [INDEX_KEY] });
    openPage({ notebook: file.notebook, path: missing }, { split: true });
  }, (e) => toast(classify(e).message, "error"));
  return (
    <div className="links-panel">
      {rows.length === 0 && <p className="muted small">This page has no links.</p>}
      {rows.map(({ link, name, result }) => {
        const key = `${link.kind}:${name}:${link.line}`;
        if ("ref" in result) return <button key={key} className="link-row" onClick={(e) => open(result.ref, e)} title={result.ref.path}>{pageTitle(result.ref.path)}</button>;
        if ("note" in result) return <button key={key} className="link-row" onClick={(e) => openMemoryNote(result.note, e.ctrlKey || e.metaKey)} title="Memory note">{result.note.title} <span className="muted small">memory</span></button>;
        if ("ambiguous" in result) return <button key={key} className="link-row" onClick={(e) => void follow(link.raw, e.ctrlKey || e.metaKey)} title="Several pages have this name">{name} <span className="muted small">several pages</span></button>;
        if ("absent" in result) return <p key={key} className="muted small link-row">{name} <span>no such memory note</span></p>;
        return (
          <div key={key} className="link-row missing">
            <span className="muted" title={result.missing}>{name}</span>
            <button className="link small" onClick={() => void create(result.missing)} title={`Create ${result.missing}`}>Create page</button>
          </div>
        );
      })}
      {dialog}
    </div>
  );
}
