import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Children, isValidElement, useEffect, useMemo, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { classify } from "../../lib/errors";
import { check, confirm, read, type Note } from "../../lib/lm";
import { ACTION_TYPES, actionItems } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";
import { shortDate } from "../../lib/text";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { useProjectsEnabled } from "../../lib/connection";
import { useNoteLinks, type NoteLinks } from "../links/useLinks";
import { projectsQuery } from "../projects/useProject";
import { HoverPreview } from "../preview/HoverPreview";
import { remarkWikilinks, WIKI_PREFIX } from "./remarkWikilinks";

export const noteQuery = (ref: string) => ({ queryKey: ["note", ref], queryFn: () => read(ref) });

function Properties({ note }: { note: Note }) {
  const enabled = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled });
  const openProject = useWorkspace((s) => s.openProject);
  const tagChip = (t: string) => {
    const project = t.startsWith("project/") ? registry.data?.projects.find((p) => p.tag === t) : undefined;
    return project
      ? <button key={t} className="chip project" title={`Open project ${project.name}`} onClick={() => openProject(project.slug, project.name)}>{project.name}</button>
      : <span key={t} className="tag">{t}</span>;
  };
  const rows: [string, ReactNode][] = [
    ["Type", <span className={`badge type-${note.type}`}>{note.type}</span>],
    ["Status", <span className={`badge status-${note.status}`}>{note.status}</span>],
    ["Tags", <span className="tags">{note.tags.map(tagChip)}</span>],
    ["Domain", note.domain],
    ["Created", shortDate(note.created)],
    ["Updated", shortDate(note.updated)],
  ];
  if (note.review_by) rows.push(["Review by", note.review_by]);
  if (note.confirmed?.length) rows.push(["Confirmed", shortDate(note.confirmed[note.confirmed.length - 1])]);
  if (note.context) rows.push(["Context", note.context]);
  if (note.files?.length) rows.push(["Files", <span className="files">{note.files.map((f) => <code key={f}>{f}</code>)}</span>]);
  if (note.origin) rows.push(["Origin", <code>{note.origin}</code>]);
  return (
    <dl className="properties">
      {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}

/** A [[link]] in reading view: resolved through the `links` graph, previewed on hover, opened on click. */
function WikiLink({ target, links, children }: { target: string; links: NoteLinks | null; children: ReactNode }) {
  const openNote = useWorkspace((s) => s.openNote);
  const openTab = useWorkspace((s) => s.openTab);
  const key = target.trim().toLowerCase();
  const node = links?.out.get(key);
  const missing = !node && links?.unresolved.has(key);
  const go = async (split: boolean) => {
    if (node) return openNote(node.ref, { split, title: node.title });
    if (missing) return openTab({ kind: "new-note", init: { title: target } }, { split });
    // No links graph (older Living Memory): resolve the title the way LM resolves a title REF.
    try { const n = await read(target, { maxChars: 1 }); openNote(`${n.domain}:${n.id}`, { split, title: n.title }); }
    catch (e) { toast(classify(e).message, "warn"); }
  };
  return (
    <HoverPreview refId={node?.ref}>
      <a href="#" className={`wikilink ${missing ? "unresolved" : ""} ${node && node.status !== "active" ? "retired" : ""}`}
        title={missing ? `No note titled “${target}” — click to create it` : undefined}
        onClick={(e) => { e.preventDefault(); go(e.ctrlKey || e.metaKey); }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); go(true); } }}>
        {children}
      </a>
    </HoverPreview>
  );
}

function ActionBox({ note, index, done }: { note: Note; index: number; done: boolean }) {
  const client = useQueryClient();
  const ref = `${note.domain}:${note.id}`;
  const tick = useMutation({
    mutationFn: (next: boolean) => check(ref, index, next),
    onSuccess: (r) => { recordOperation(r.operation_id); client.invalidateQueries({ queryKey: ["note", ref] }); },
    onError: (e) => toast(classify(e).message, "error"),
  });
  return (
    <input type="checkbox" className="action-box" checked={tick.isPending ? !done : done} disabled={tick.isPending}
      title={done ? "Mark as not done" : "Mark as done"} onChange={() => tick.mutate(!done)} />
  );
}

export function NoteView({ refId, tabId }: { refId: string; tabId: string }) {
  const client = useQueryClient();
  const note = useQuery(noteQuery(refId));
  const { note: links } = useNoteLinks(refId);
  const updateTab = useWorkspace((s) => s.updateTab);
  const reveal = useWorkspace((s) => s.reveal);
  const n = note.data;
  useEffect(() => { if (n) updateTab(tabId, { title: n.title }); }, [n?.title, tabId, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reveal?.tabId === tabId) document.getElementById(`${tabId}-l${reveal.line}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reveal, tabId]);
  const still = useMutation({
    mutationFn: () => confirm(refId),
    onSuccess: (r) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["note", refId] });
      toast(r.status === "unchanged" ? "Already confirmed today." : `Confirmed. Next review ${r.review_by ?? "later"}.`);
    },
    onError: (e) => toast(classify(e).message, "error"),
  });

  const components = useMemo<Components>(() => {
    if (!n) return {};
    const tickable = ACTION_TYPES.has(n.type) && n.status === "active";
    const items = new Map(actionItems(n.body).map((a) => [a.line, a]));
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] =>
      ({ node, children }) => <Tag id={`${tabId}-l${(node?.position?.start.line ?? 1) - 1}`}>{children}</Tag>;
    return {
      a: ({ href, children }) => {
        if (href?.startsWith(WIKI_PREFIX)) {
          return <WikiLink target={decodeURIComponent(href.slice(WIKI_PREFIX.length))} links={links}>{children}</WikiLink>;
        }
        // Never navigate the app window; open web links in the system browser.
        return <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openUrl(href); }}>{children}</a>;
      },
      li: ({ node, className, children }) => {
        const item = items.get((node?.position?.start.line ?? 0) - 1);
        if (!className?.includes("task-list-item") || !item || !tickable) return <li className={className}>{children}</li>;
        return (
          <li className={className}>
            {Children.map(children, (c) => (isValidElement(c) && c.type === "input" ? <ActionBox note={n} index={item.index} done={item.done} /> : c))}
          </li>
        );
      },
      h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
    };
  }, [n, links, tabId]);

  if (note.isLoading) return <p className="muted pad">Loading…</p>;
  if (note.error) return <p className="error pad">{classify(note.error).message}</p>;
  if (!n) return null;
  return (
    <article className="note">
      <div className="note-head">
        <h1 onDoubleClick={() => updateTab(tabId, { mode: "live" })} title="Double-click to edit">{n.title}</h1>
        {n.status === "active" && (
          <button onClick={() => still.mutate()} disabled={still.isPending} title="Confirm this note still holds (pushes its review date out)">
            Still true
          </button>
        )}
      </div>
      <Properties note={n} />
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm, remarkWikilinks]} components={components}
          urlTransform={(url) => (url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url))}>
          {n.body}
        </Markdown>
      </div>
      {n.truncated && <p className="muted">This note is longer than 64,000 characters; the rest is not shown.</p>}
    </article>
  );
}
