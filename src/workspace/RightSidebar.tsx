import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keyOf, useDocuments } from "../documents/store";
import { isLoose, recentQuery, recentRef } from "../lib/opens";
import { useNotebookTitle } from "../features/notes/notebookTitle";
import { isRichDoc } from "../lib/notebooks";
import { outline } from "../lib/note";
import { richOutline } from "../features/hmdoc/outline";
import { SourceHistory } from "../features/history/HistoryViews";
import { Backlinks, OutgoingLinks } from "../features/links/BacklinksPanel";
import { LinksPanel, LocalGraphPanel } from "../features/links/LinksPanel";
import { RelatedPages } from "../features/links/RelatedPanel";
import { isLm } from "../documents/adapters/lmdoc";
import { Outline } from "../features/outline/Outline";
import { NoteDetails, noteQuery } from "../features/viewer/NoteView";
import { ArrowLink, Section } from "../ui/Page";
import { activeTab, useWorkspace, type Tab, type TabKind } from "./store";

/** The context rail beside the focused note: what it connects to, how it changed, and where to jump inside it. */
export function NoteRail() {
  const tab = useWorkspace(activeTab);
  const updateTab = useWorkspace((s) => s.updateTab);
  const ref = tab?.kind === "note" ? tab.ref : undefined;
  const note = useQuery({ ...noteQuery(ref ?? ""), enabled: !!ref });
  // The graph draws into its container, so it is mounted only while the disclosure is open and has a size.
  const [graph, setGraph] = useState(false);
  if (!tab || !ref) return <aside className="note-rail"><p className="muted">Open a saved note to see its connections and history.</p></aside>;
  return (
    <aside className="note-rail">
      <Section title="Connections"><LinksPanel tab={tab} /></Section>
      <Section title="Source history" actions={<ArrowLink onClick={() => updateTab(tab.id, { mode: "history" })}>All</ArrowLink>}>
        <SourceHistory key={ref} refId={ref} />
      </Section>
      <Section title="On this page"><Outline tab={tab} /></Section>
      {note.data && <Section title="Details"><NoteDetails note={note.data} /></Section>}
      <details className="rail-more" open={graph} onToggle={(e) => setGraph(e.currentTarget.open)}>
        <summary>Local graph</summary>
        {graph && <LocalGraphPanel key={ref} tab={tab} />}
      </details>
    </aside>
  );
}

/** The most headings the outline lists; a longer page says how many more it has. */
export const OUTLINE_MAX = 500;

/** Pages longer than this update their outline once typing pauses. */
const OUTLINE_SETTLE_OVER = 100_000;
const OUTLINE_SETTLE_MS = 400;

/** `value`, or for a long text its value once it has stopped changing for a moment. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  const long = value.length > OUTLINE_SETTLE_OVER;
  useEffect(() => {
    if (!long) return;
    const timer = setTimeout(() => setSettled(value), OUTLINE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value, long]);
  return long ? settled : value;
}

/** Headings of an open page, from its current text (unsaved edits included). A long page's outline follows once typing
 *  pauses, and the list is capped, so typing never waits for it (NS-3A UI pass: a 950 KB page with 17,000 headings
 *  took about 0.7 s per key). */
export function PageOutline({ tab }: { tab: Tab }) {
  const current = useDocuments((s) => (tab.file ? s.docs[keyOf(tab.file)]?.text : undefined)) ?? "";
  const text = useSettled(current);
  const revealLine = useWorkspace((s) => s.revealLine);
  // A rich page is JSON, not Markdown: its headings come from its document, and are named by their order (UI-1).
  const rich = !!tab.file && isRichDoc(tab.file.path);
  const headings = useMemo(() => (rich ? richOutline(text) : outline(text)), [text, rich]);
  // The list is made once per outline, not on every keystroke that leaves it the same.
  const list = useMemo(() => {
    if (!headings.length) return <p className="muted pad">No headings.</p>;
    const top = headings.reduce((m, h) => Math.min(m, h.level), 6);
    const more = headings.length - OUTLINE_MAX;
    return (
      <ul className="outline">
        {headings.slice(0, OUTLINE_MAX).map((h) => (
          <li key={h.line} style={{ paddingLeft: (h.level - top) * 12 }}>
            <button onClick={() => revealLine(tab.id, h.line)}>{h.text}</button>
          </li>
        ))}
        {more > 0 && <li className="muted">{more.toLocaleString()} more {more === 1 ? "heading" : "headings"}</li>}
      </ul>
    );
  }, [headings, revealLine, tab.id]);
  return list;
}

/** The rail beside a notebook page: its outline, what links to and from it, and where the file is. */
export function PageRail() {
  const tab = useWorkspace(activeTab);
  const base = useDocuments((s) => (tab?.file ? s.docs[keyOf(tab.file)]?.base : undefined));
  const recent = useQuery({ ...recentQuery(), enabled: !!tab?.file && isLoose(tab.file) });
  const title = useNotebookTitle(tab?.file?.notebook, !!tab?.file && !isLoose(tab.file));
  if (!tab?.file) return <aside className="note-rail"><p className="muted">Open a page to see its outline.</p></aside>;
  const full = recent.data?.find((r) => recentRef(r).notebook === tab.file!.notebook)?.path;
  const rows: [string, ReactNode][] = isLoose(tab.file)
    ? [["File", <code>{full ?? tab.file.path}</code>]]
    : [["Notebook", title ?? tab.file.notebook], ["Path", <code>{tab.file.path}</code>]];
  if (base) {
    rows.push(["Size", `${base.stamp.size.toLocaleString()} bytes`], ["Modified", new Date(base.stamp.mtimeMs).toLocaleString()]);
    rows.push(["Format", `${base.format.encoding}${base.format.bom ? " with BOM" : ""}, ${base.format.eol.toUpperCase()} line endings`]);
  }
  return (
    <aside className="note-rail">
      <Section title="On this page"><PageOutline tab={tab} /></Section>
      {/* The index covers folder notebooks; a loose file or a Living Memory page has no backlinks to show. */}
      {!isLoose(tab.file) && !isLm(tab.file) && (
        <>
          <Section title="Backlinks"><Backlinks file={tab.file} /></Section>
          <Section title="Outgoing links"><OutgoingLinks file={tab.file} /></Section>
          <Section title="Related"><RelatedPages file={tab.file} /></Section>
        </>
      )}
      <Section title="File">
        <dl className="properties">
          {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
        </dl>
      </Section>
    </aside>
  );
}

const RAIL_VIEWS: Record<TabKind, () => ReactNode> = { note: () => <NoteRail />, "new-note": () => <NoteRail />, file: () => <PageRail />, "new-file": () => <PageRail /> };

/** The rail for whatever the focused tab shows. */
export function ContextRail() {
  const kind = useWorkspace((s) => activeTab(s)?.kind ?? "note");
  return <>{RAIL_VIEWS[kind]()}</>;
}
