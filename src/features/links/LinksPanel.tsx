import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useMemo, useState } from "react";
import { useChangesEnabled, useConnection } from "../../lib/connection";
import { domainOf, type LinkNode } from "../../lib/lm";
import { openChange } from "../../store";
import { Row } from "../../ui/Page";
import { useWorkspace, type Tab } from "../../workspace/store";
import { changesFor } from "../changes/changes";
import { changesQuery } from "../changes/useChanges";
import { GraphCanvas } from "../graph/GraphCanvas";
import { neighborhood, TYPE_COLORS } from "../graph/graphData";
import { HoverPreview } from "../preview/HoverPreview";
import { useLinks, useNoteLinks } from "./useLinks";

function NoteLink({ node }: { node: LinkNode }) {
  const openNote = useWorkspace((s) => s.openNote);
  return (
    <HoverPreview refId={node.ref}>
      <button className={`link-row ${node.status !== "active" ? "retired" : ""}`}
        onClick={(e) => openNote(node.ref, { split: e.ctrlKey || e.metaKey, title: node.title })}>
        <span className="swatch" style={{ background: TYPE_COLORS[node.type] }} />{node.title}
        {node.status !== "active" && <span className="muted small"> · {node.status}</span>}
      </button>
    </HoverPreview>
  );
}

const needsUpdate = <p className="muted pad">Backlinks need Living Memory's <code>links</code> command. Update Living Memory to see them.</p>;

/** Who links here, where this note links, what it replaced or was replaced by, and links to nothing. */
export function LinksPanel({ tab }: { tab: Tab }) {
  const supported = useConnection((c) => c.commands.includes("links"));
  const openTab = useWorkspace((s) => s.openTab);
  const { note: links, isLoading } = useNoteLinks(tab.ref);
  const all = useQuery({ ...changesQuery(), enabled: useChangesEnabled() });
  if (!supported) return needsUpdate;
  if (isLoading || !links) return <p className="muted pad">Loading…</p>;
  const section = (title: string, rows: { node: LinkNode }[]) => (
    <section className="links-section">
      <h4>{title} <span className="muted">{rows.length}</span></h4>
      {rows.length ? rows.map((r) => <NoteLink key={r.node.ref} node={r.node} />) : <p className="muted small">None.</p>}
    </section>
  );
  return (
    <div className="links-panel">
      {changesFor(tab.ref!, links, all.data?.changes ?? []).map((c) => (
        <Row key={c.id} icon={<GitBranch size="1.3em" aria-hidden />} onClick={() => openChange(c.id)}><strong>{c.display}</strong> · {c.title}</Row>
      ))}
      {section("Linked from", links.incoming.filter((e) => e.kind === "link"))}
      {section("Links to", links.outgoing.filter((e) => e.kind === "link"))}
      {links.outgoing.some((e) => e.kind === "supersedes") && section("Replaces", links.outgoing.filter((e) => e.kind === "supersedes"))}
      {links.incoming.some((e) => e.kind === "supersedes") && section("Replaced by", links.incoming.filter((e) => e.kind === "supersedes"))}
      {links.unresolved.size > 0 && (
        <section className="links-section">
          <h4>Links to missing notes <span className="muted">{links.unresolved.size}</span></h4>
          {[...links.unresolved].map((t) => (
            <button key={t} className="link-row unresolved" title="Create this note"
              onClick={() => openTab({ kind: "new-note", init: { title: t, domain: domainOf(tab.ref!) } }, { split: true })}>+ {t}</button>
          ))}
        </section>
      )}
    </div>
  );
}

/** The notes around this one, one or two links away. */
export function LocalGraphPanel({ tab }: { tab: Tab }) {
  const supported = useConnection((c) => c.commands.includes("links"));
  const openNote = useWorkspace((s) => s.openNote);
  const [depth, setDepth] = useState(1);
  const graph = useLinks(tab.ref ? domainOf(tab.ref) : null);
  const near = useMemo(() => graph.data && tab.ref ? neighborhood(graph.data, tab.ref, depth) : null, [graph.data, tab.ref, depth]);
  if (!supported) return needsUpdate;
  if (!near) return <p className="muted pad">Loading…</p>;
  return (
    <div className="local-graph">
      <div className="segmented compact">
        {[1, 2].map((d) => <button key={d} className={depth === d ? "on" : ""} onClick={() => setDepth(d)}>{d} link{d > 1 ? "s" : ""} away</button>)}
      </div>
      {near.nodes.length > 1
        ? <GraphCanvas data={near} focus={tab.ref} compact onOpen={(ref, title, split) => openNote(ref, { split, title })} />
        : <p className="muted pad">No links to or from this note yet.</p>}
    </div>
  );
}
