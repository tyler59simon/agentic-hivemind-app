import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useConnection } from "../../lib/connection";
import { taxonomy, type NoteType } from "../../lib/lm";
import { tagsQuery } from "../../lib/noteindex";
import { useNoteTypes } from "../../lib/noteTypes";
import { GraphCanvas } from "./GraphCanvas";
import { filterGraph, PAGE_COLOR, typeColor } from "./graphData";
import { openGraphNode, useUnifiedGraph } from "./useUnifiedGraph";

/** One graph across Living Memory notes and folder notebook pages, with cross-links and filters (CON-12). */
export function GraphView({ projectTag, projectName }: { projectTag?: string; projectName?: string }) {
  const { graph, linksSupported, notebooks, isLoading, memoryError, pagesError } = useUnifiedGraph();
  const taxEnabled = useConnection((c) => c.commands.includes("taxonomy"));
  const memTags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy, enabled: taxEnabled });
  const pageTags = useQuery(tagsQuery());
  const noteTypes = useNoteTypes();

  const [allMemory, setAllMemory] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const [showPages, setShowPages] = useState(true);
  const [notebook, setNotebook] = useState("");
  const [types, setTypes] = useState<NoteType[]>([]);
  const [tag, setTag] = useState("");
  const [retired, setRetired] = useState(false);

  const mergedTags = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const t of pageTags.data ?? []) map.set(t.tag, t.count);
    for (const t of memTags.data?.tags ?? []) if (!map.has(t)) map.set(t, null);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pageTags.data, memTags.data]);

  const shown = useMemo(() => filterGraph(graph, {
    showNotes,
    showPages,
    projectTag: projectTag && !allMemory ? projectTag : undefined,
    notebook: notebook || undefined,
    types,
    tag: tag || undefined,
    includeRetired: retired,
  }), [graph, showNotes, showPages, projectTag, allMemory, notebook, types, tag, retired]);

  const noteCount = shown.nodes.filter((n) => n.kind === "note").length;
  const pageCount = shown.nodes.length - noteCount;

  return (
    <div className="graph-view">
      <h1 className="visually-hidden">Graph</h1>
      <div className="graph-filters">
        {projectName && (
          <button type="button" className={`chip${allMemory ? " on" : ""}`} aria-pressed={allMemory}
            onClick={() => setAllMemory((v) => !v)}
            title={allMemory ? "Showing memory notes from all projects" : `Memory notes scoped to ${projectName}; click for all memory`}>
            {allMemory ? "All memory" : projectName}
          </button>
        )}
        <button type="button" className={`chip${showNotes ? " on" : ""}`} aria-pressed={showNotes}
          onClick={() => setShowNotes((v) => !v)}>Notes</button>
        <button type="button" className={`chip${showPages ? " on" : ""}`} aria-pressed={showPages}
          onClick={() => setShowPages((v) => !v)}>
          <span className="swatch" style={{ background: PAGE_COLOR }} />Pages
        </button>
        {showPages && notebooks.length > 0 && (
          <select value={notebook} onChange={(e) => setNotebook(e.target.value)} aria-label="Notebook">
            <option value="">All notebooks</option>
            {notebooks.map((nb) => <option key={nb.id} value={nb.id}>{nb.title}</option>)}
          </select>
        )}
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">Any tag</option>
          {mergedTags.map(([t, count]) => <option key={t} value={t}>{count !== null ? `#${t} (${count})` : t}</option>)}
        </select>
        {showNotes && (
          <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Include archived</label>
        )}
        {showNotes && (
          <div className="chips">
            {noteTypes.all.map(({ name: t }) => (
              <button key={t} type="button" className={`chip ${types.includes(t) ? "on" : ""}`}
                onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])}>
                <span className="swatch" style={{ background: typeColor(t) }} />{t}
              </button>
            ))}
          </div>
        )}
        <span className="muted small">
          {noteCount} {noteCount === 1 ? "note" : "notes"} · {pageCount} {pageCount === 1 ? "page" : "pages"} · {shown.edges.length} {shown.edges.length === 1 ? "link" : "links"}
        </span>
      </div>
      {!linksSupported && <p className="muted small pad">Memory note links need Living Memory's <code>links</code> command; showing folder notebook pages only.</p>}
      {memoryError && <p className="error pad">{String(memoryError)}</p>}
      {pagesError && <p className="error pad">{String(pagesError)}</p>}
      {isLoading && !shown.nodes.length && <p className="muted pad">Loading the graph…</p>}
      {(!isLoading || shown.nodes.length > 0) && (shown.nodes.length
        ? <GraphCanvas data={shown} onOpen={openGraphNode} />
        : <p className="muted pad">No notes or pages match these filters.</p>)}
    </div>
  );
}
