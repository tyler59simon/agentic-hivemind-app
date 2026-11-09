import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useConnection } from "../../lib/connection";
import { domains, links, NOTE_TYPES, taxonomy, type NoteType } from "../../lib/lm";
import { useWorkspace } from "../../workspace/store";
import { GraphCanvas } from "./GraphCanvas";
import { filterGraph, TYPE_COLORS } from "./graphData";

/** The whole store as a graph: [[links]] and supersedes between notes, coloured by type. */
export function GraphView() {
  const supported = useConnection((c) => c.commands.includes("links"));
  const openNote = useWorkspace((s) => s.openNote);
  const [domain, setDomain] = useState("");
  const [types, setTypes] = useState<NoteType[]>([]);
  const [tag, setTag] = useState("");
  const [retired, setRetired] = useState(false);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const tags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const graph = useQuery({ queryKey: ["links", "*"], queryFn: () => links({ allDomains: true, status: "any" }), enabled: supported });
  const shown = useMemo(() => graph.data && filterGraph(graph.data, { domain: domain || undefined, types, tag: tag || undefined, includeRetired: retired }),
    [graph.data, domain, types, tag, retired]);

  if (!supported) return <p className="muted pad">The graph needs Living Memory's <code>links</code> command. Update Living Memory to use it.</p>;
  return (
    <div className="graph-view">
      <div className="graph-filters">
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
          <option value="">All domains</option>
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">Any tag</option>
          {tags.data?.tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Include archived</label>
        <div className="chips">
          {NOTE_TYPES.map((t) => (
            <button key={t} className={`chip ${types.includes(t) ? "on" : ""}`} onClick={() => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])}>
              <span className="swatch" style={{ background: TYPE_COLORS[t] }} />{t}
            </button>
          ))}
        </div>
        {shown && <span className="muted small">{shown.nodes.length} notes · {shown.edges.length} links</span>}
      </div>
      {graph.error && <p className="error pad">{String(graph.error)}</p>}
      {graph.isLoading && <p className="muted pad">Loading the graph…</p>}
      {shown && (shown.nodes.length
        ? <GraphCanvas data={shown} onOpen={(ref, title, split) => openNote(ref, { split, title })} />
        : <p className="muted pad">No notes match these filters.</p>)}
    </div>
  );
}
