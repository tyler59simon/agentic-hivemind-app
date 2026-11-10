import { useQuery } from "@tanstack/react-query";
import { SourceHistory } from "../features/history/HistoryViews";
import { LinksPanel, LocalGraphPanel } from "../features/links/LinksPanel";
import { Outline } from "../features/outline/Outline";
import { NoteDetails, noteQuery } from "../features/viewer/NoteView";
import { ArrowLink, Section } from "../ui/Page";
import { activeTab, useWorkspace } from "./store";

/** The context rail beside the focused note: what it connects to, how it changed, and where to jump inside it. */
export function NoteRail() {
  const tab = useWorkspace(activeTab);
  const updateTab = useWorkspace((s) => s.updateTab);
  const ref = tab?.kind === "note" ? tab.ref : undefined;
  const note = useQuery({ ...noteQuery(ref ?? ""), enabled: !!ref });
  if (!tab || !ref) return <aside className="note-rail"><p className="muted">Open a saved note to see its connections and history.</p></aside>;
  return (
    <aside className="note-rail">
      <Section title="Connections"><LinksPanel tab={tab} /></Section>
      <Section title="Source history" actions={<ArrowLink onClick={() => updateTab(tab.id, { mode: "history" })}>All</ArrowLink>}>
        <SourceHistory key={ref} refId={ref} />
      </Section>
      <Section title="On this page"><Outline tab={tab} /></Section>
      {note.data && <Section title="Details"><NoteDetails note={note.data} /></Section>}
      <details className="rail-more">
        <summary>Local graph</summary>
        <LocalGraphPanel key={ref} tab={tab} />
      </details>
    </aside>
  );
}
