import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { keyOf, useDocuments } from "../documents/store";
import { notebooksQuery } from "../lib/notebooks";
import { isLoose, recentQuery, recentRef } from "../lib/opens";
import { outline } from "../lib/note";
import { SourceHistory } from "../features/history/HistoryViews";
import { LinksPanel, LocalGraphPanel } from "../features/links/LinksPanel";
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

/** Headings of an open page, from its current text (unsaved edits included). */
function PageOutline({ tab }: { tab: Tab }) {
  const text = useDocuments((s) => (tab.file ? s.docs[keyOf(tab.file)]?.text : undefined)) ?? "";
  const revealLine = useWorkspace((s) => s.revealLine);
  const headings = outline(text);
  if (!headings.length) return <p className="muted pad">No headings.</p>;
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <ul className="outline">
      {headings.map((h) => (
        <li key={h.line} style={{ paddingLeft: (h.level - top) * 12 }}>
          <button onClick={() => revealLine(tab.id, h.line)}>{h.text}</button>
        </li>
      ))}
    </ul>
  );
}

/** The rail beside a notebook page: its outline and where the file is. */
export function PageRail() {
  const tab = useWorkspace(activeTab);
  const notebooks = useQuery(notebooksQuery());
  const base = useDocuments((s) => (tab?.file ? s.docs[keyOf(tab.file)]?.base : undefined));
  const recent = useQuery({ ...recentQuery(), enabled: !!tab?.file && isLoose(tab.file) });
  if (!tab?.file) return <aside className="note-rail"><p className="muted">Open a page to see its outline.</p></aside>;
  const nb = notebooks.data?.find((n) => n.id === tab.file!.notebook);
  const full = recent.data?.find((r) => recentRef(r).notebook === tab.file!.notebook)?.path;
  const rows: [string, ReactNode][] = isLoose(tab.file)
    ? [["File", <code>{full ?? tab.file.path}</code>]]
    : [["Notebook", nb?.title ?? tab.file.notebook], ["Path", <code>{tab.file.path}</code>]];
  if (base) {
    rows.push(["Size", `${base.stamp.size.toLocaleString()} bytes`], ["Modified", new Date(base.stamp.mtimeMs).toLocaleString()]);
    rows.push(["Format", `${base.format.encoding}${base.format.bom ? " with BOM" : ""}, ${base.format.eol.toUpperCase()} line endings`]);
  }
  return (
    <aside className="note-rail">
      <Section title="On this page"><PageOutline tab={tab} /></Section>
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
