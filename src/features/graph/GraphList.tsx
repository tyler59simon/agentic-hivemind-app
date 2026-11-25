import { useMemo } from "react";
import { graphList, nodeColor, type UnifiedGraph, type UnifiedNode } from "./graphData";

const kindOf = (n: UnifiedNode) => (n.kind === "note" ? n.noteType : "page");

/** The graph as a list, for people who cannot use the drawing: every shown node by title with its kind and link count, and the
 *  nodes it is linked to. A button opens the node the way a click on the drawing does (Ctrl/Cmd+click in a split). */
export function GraphList({ data, onOpen }: { data: UnifiedGraph; onOpen: (node: UnifiedNode, split: boolean) => void }) {
  const items = useMemo(() => graphList(data), [data]);
  const open = (node: UnifiedNode) => (e: { ctrlKey: boolean; metaKey: boolean }) => onOpen(node, e.ctrlKey || e.metaKey);
  return (
    <ul className="graph-list" aria-label="Notes and pages">
      {items.map(({ node, links, neighbours }) => (
        <li key={node.id}>
          <button type="button" className="link-row" onClick={open(node)}>
            <span className="swatch" style={{ background: nodeColor(node) }} aria-hidden="true" />{node.title}
          </button>
          <span className="muted small"> {kindOf(node)} · {links} {links === 1 ? "link" : "links"}</span>
          {neighbours.length > 0 && (
            <ul aria-label={`Linked with ${node.title}`}>
              {neighbours.map((n) => (
                <li key={n.id}><button type="button" className="link-row" onClick={open(n)}>{n.title}</button></li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
