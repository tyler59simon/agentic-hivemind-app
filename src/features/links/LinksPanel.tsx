import { useMemo, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { useConnection } from "../../lib/connection";
import { domainOf, type LinkNode } from "../../lib/lm";
import { useWorkspace, type Tab } from "../../workspace/store";
import { GraphCanvas } from "../graph/GraphCanvas";
import { neighborhood, pageNodeId, typeColor } from "../graph/graphData";
import { openGraphNode, useUnifiedGraph } from "../graph/useUnifiedGraph";
import { HoverPreview } from "../preview/HoverPreview";
import { useNoteLinks } from "./useLinks";

function NoteLink({ node }: { node: LinkNode }) {
  const openNote = useWorkspace((s) => s.openNote);
  return (
    <HoverPreview refId={node.ref}>
      <button className={`link-row ${node.status !== "active" ? "retired" : ""}`}
        onClick={(e) => openNote(node.ref, { split: e.ctrlKey || e.metaKey, title: node.title })}>
        <span className="swatch" style={{ background: typeColor(node.type) }} />{node.title}
        {node.status !== "active" && <span className="muted small"> · {node.status}</span>}
      </button>
    </HoverPreview>
  );
}

const needsUpdate = <p className="muted pad">Backlinks need Living Memory's <code>links</code> command. Update Living Memory to see them.</p>;

/** Who links here, where this note links, what it replaced or was replaced by, and links to nothing. */
export function LinksPanel({ tab }: { tab: Tab }) {
  const supported = useConnection((c) => c.commands.includes("search"));
  const openTab = useWorkspace((s) => s.openTab);
  const { note: links, isLoading } = useNoteLinks(tab.ref);
  if (!supported) return needsUpdate;
  if (isLoading || !links) return <p className="muted pad">Loading…</p>;
  const section = (title: string, rows: { node: LinkNode }[]) => (
    <section className="links-section">
      <h3>{title} <span className="muted">{rows.length}</span></h3>
      {rows.length ? rows.map((r) => <NoteLink key={r.node.ref} node={r.node} />) : <p className="muted small">None.</p>}
    </section>
  );
  return (
    <div className="links-panel">
      {section("Linked from", links.incoming.filter((e) => e.kind === "link"))}
      {section("Links to", links.outgoing.filter((e) => e.kind === "link"))}
      {links.outgoing.some((e) => e.kind === "supersedes") && section("Replaces", links.outgoing.filter((e) => e.kind === "supersedes"))}
      {links.incoming.some((e) => e.kind === "supersedes") && section("Replaced by", links.incoming.filter((e) => e.kind === "supersedes"))}
      {links.unresolved.size > 0 && (
        <section className="links-section">
          <h3>Links to missing notes <span className="muted">{links.unresolved.size}</span></h3>
          {[...links.unresolved].map((t) => (
            <button key={t} className="link-row unresolved" title="Create this note"
              onClick={() => openTab({ kind: "new-note", init: { title: t, domain: domainOf(tab.ref!) } }, { split: true })}>+ {t}</button>
          ))}
        </section>
      )}
    </div>
  );
}

/** The notes and folder pages around this note or page, one or two links away (CON-12). */
export function LocalGraphPanel({ focusRef, focusFile }: { focusRef?: string; focusFile?: FileRef }) {
  const [depth, setDepth] = useState(1);
  const { graph, linksSupported, isLoading } = useUnifiedGraph();
  const focusId = focusFile ? pageNodeId(focusFile) : focusRef;
  const near = useMemo(() => (focusId ? neighborhood(graph, focusId, depth) : null), [graph, focusId, depth]);
  if (focusRef && !linksSupported) return needsUpdate;
  if (isLoading && (!near || near.nodes.length <= 1)) return <p className="muted pad">Loading…</p>;
  return (
    <div className="local-graph">
      <div className="segmented compact">
        {[1, 2].map((d) => <button key={d} className={depth === d ? "on" : ""} aria-pressed={depth === d} onClick={() => setDepth(d)}>{d} link{d > 1 ? "s" : ""} away</button>)}
      </div>
      {near && near.nodes.length > 1
        ? <GraphCanvas data={near} focus={focusId} compact onOpen={openGraphNode} />
        : <p className="muted pad">No links to or from this {focusFile ? "page" : "note"} yet.</p>}
    </div>
  );
}
