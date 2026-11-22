// The edges of a board (NS-7C): one SVG under the cards, and an HTML label over each edge that has one. Memoized like the
// cards: an edge draws again only when its card ends, its colour, its label or its selection changes.
import { memo, useMemo } from "react";
import { colourStyle } from "./nodes/NodeView";
import { arrowPath, edgeShape, facing, type CanvasEdge, type CanvasNode } from "./model";

function shapeOf(e: CanvasEdge, a: CanvasNode, b: CanvasNode) {
  const [fs, ts] = facing(a, b);
  return edgeShape(a, b, e.fromSide ?? fs, e.toSide ?? ts);
}

const EdgePath = memo(function EdgePath({ edge, from, to, selected }: { edge: CanvasEdge; from: CanvasNode; to: CanvasNode; selected: boolean }) {
  const shape = shapeOf(edge, from, to);
  const { className, style } = colourStyle(edge.color);
  // `toEnd` is an arrow unless the file says otherwise; `fromEnd` is none.
  return (
    <g className={`canvas-edge ${className} ${selected ? "on" : ""}`} style={style} data-edge-id={edge.id}>
      <path className="canvas-edge-hit" d={shape.d} />
      <path className="canvas-edge-line" d={shape.d} />
      {(edge.toEnd ?? "arrow") === "arrow" && <path className="canvas-arrow" d={arrowPath(shape.to.tip, shape.to.dir)} />}
      {edge.fromEnd === "arrow" && <path className="canvas-arrow" d={arrowPath(shape.from.tip, shape.from.dir)} />}
    </g>
  );
});

export interface EdgeLabelProps { edge: CanvasEdge; from: CanvasNode; to: CanvasNode; selected: boolean; editing: boolean; onDone: (id: string, label: string | null) => void }

const EdgeLabel = memo(function EdgeLabel({ edge, from, to, selected, editing, onDone }: EdgeLabelProps) {
  const { mid } = shapeOf(edge, from, to);
  const { className, style } = colourStyle(edge.color);
  if (!editing && !edge.label) return null;
  return (
    <div className={`canvas-edge-label ${className} ${selected ? "on" : ""}`} style={{ ...style, left: mid.x, top: mid.y }} data-edge-id={edge.id}>
      {editing
        ? <input autoFocus defaultValue={edge.label ?? ""} aria-label="Edge label" onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onDone(edge.id, e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); onDone(edge.id, e.currentTarget.value); }
            else if (e.key === "Escape") { e.preventDefault(); onDone(edge.id, null); }
          }} />
        : edge.label}
    </div>
  );
});

/** Every edge whose two cards are on the board. An edge that names a missing card is kept in the file and not drawn. */
export const EdgesLayer = memo(function EdgesLayer({ nodes, edges, selected, editing, onLabel }: {
  nodes: CanvasNode[]; edges: CanvasEdge[]; selected: string | null; editing: string | null; onLabel: (id: string, label: string | null) => void;
}) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const drawn = edges.flatMap((edge) => {
    const from = byId.get(edge.fromNode), to = byId.get(edge.toNode);
    return from && to ? [{ edge, from, to }] : [];
  });
  return (
    <>
      <svg className="canvas-edges" width="1" height="1" aria-hidden>
        {drawn.map(({ edge, from, to }) => <EdgePath key={edge.id} edge={edge} from={from} to={to} selected={selected === edge.id} />)}
      </svg>
      {drawn.map(({ edge, from, to }) => (
        <EdgeLabel key={edge.id} edge={edge} from={from} to={to} selected={selected === edge.id} editing={editing === edge.id} onDone={onLabel} />
      ))}
    </>
  );
});
