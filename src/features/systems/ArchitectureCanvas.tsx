import { useQuery } from "@tanstack/react-query";
import { useLayer } from "../../ui/layers";
import { Bell, Box, Database, Maximize, Minimize, Minus, Plus, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { systemDiagramSource, type ArchModel } from "../../lib/architecture";
import { changeCount, type ModelDiff } from "./compare";
import { canvasGraph, fitScale, layoutGraph, type CanvasNode, type Level } from "./canvas";
import type { DiagramEntry } from "./passport";
import { useDiagram } from "./useSystem";

type Shown = Level | "deployment";
const LEVELS: { id: Shown; label: string }[] = [{ id: "context", label: "Context" }, { id: "containers", label: "Containers" }, { id: "deployment", label: "Deployment" }];
const ZOOM = { min: 0.2, max: 2.5, step: 1.2 };
const clamp = (scale: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, scale));

const KIND: Record<CanvasNode["kind"], string> = { person: "Person", software_system: "System", container: "Container", component: "Component", code: "Code" };
/** "Container · Spring Boot" */
export const kindLine = (n: Pick<CanvasNode, "kind" | "technology" | "external">) =>
  [n.external && n.kind !== "person" ? `External ${KIND[n.kind].toLowerCase()}` : KIND[n.kind], n.technology].filter(Boolean).join(" · ");

function icon(n: CanvasNode): ReactNode {
  if (n.kind === "person") return <User size={20} aria-hidden />;
  if (/queue|topic|bus|stream|notif/i.test(`${n.name} ${n.technology ?? ""}`)) return <Bell size={20} aria-hidden />;
  if (/store|database|\bdb\b|sql|dynamo|bucket|cache|redis/i.test(`${n.name} ${n.technology ?? ""}`)) return <Database size={20} aria-hidden />;
  return <Box size={20} aria-hidden />;
}

/** `diff-added` or `diff-changed` for a box (`""`) or an arrow (`"Edges"`) a comparison found, else nothing. */
function tint(diff: { result: ModelDiff } | null | undefined, id: string, edges: "" | "Edges"): string {
  const r = diff?.result;
  if (!r) return "";
  return (edges ? r.addedEdges : r.added).includes(id) ? "diff-added" : (edges ? r.changedEdges : r.changed).includes(id) ? "diff-changed" : "";
}

/** A smooth line through dagre's points. */
function path(points: { x: number; y: number }[]): string {
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += ` Q${points[i].x},${points[i].y} ${i === points.length - 2 ? points[i + 1].x : mid.x},${i === points.length - 2 ? points[i + 1].y : mid.y}`;
  }
  return d;
}

/** The suite's own picture of a level the canvas does not draw (deployment), on the white page it was rendered for. */
function Picture({ slug, entry, version }: { slug: string; entry: DiagramEntry; version: number | null }) {
  const image = useDiagram(slug, entry.path, version);
  if (image.isLoading) return <p className="muted pad">Loading diagram…</p>;
  if (image.error) return <p className="error pad">{String(image.error)}</p>;
  return <div className="canvas-picture"><img src={image.data} alt={entry.title} /></div>;
}

function Source({ slug, entry, version }: { slug: string; entry: DiagramEntry; version: number | null }) {
  const file = entry.path.replace(/\.[^./]+$/, ".mmd");
  // Kept until the folder is regenerated, like the diagram pictures.
  const text = useQuery({ queryKey: ["architecture", slug, "source", file, version], queryFn: () => systemDiagramSource(slug, file), staleTime: Infinity, retry: false });
  if (text.isLoading) return <p className="muted pad">Loading…</p>;
  if (text.error) return <p className="muted pad">No Mermaid source was generated for this diagram.</p>;
  return <pre className="canvas-source">{text.data}</pre>;
}

const MAX_NAMES = 6;

/** What a comparison found. Removed boxes and arrows are not drawn, so they are named here. */
function Legend({ result, label }: { result: ModelDiff; label: string }) {
  const counts = [
    { kind: "added", text: "Added", n: result.added.length + result.addedEdges.length },
    { kind: "changed", text: "Changed", n: result.changed.length + result.changedEdges.length },
    { kind: "removed", text: "Removed", n: result.removed.length + result.removedEdges.length },
  ];
  const names = [...result.removed.map((e) => e.name), ...result.removedEdges.map((e) => `${e.from} → ${e.to}`)];
  return (
    <div className="canvas-legend" role="status">
      {!changeCount(result) ? <span>No differences from {label}.</span> : (
        <>
          <span>Compared with {label}:</span>
          {counts.filter((c) => c.n > 0).map(({ kind, text, n }) => <span key={kind}><span className={`swatch ${kind}`} />{text} {n}</span>)}
          {!!names.length && <span className="muted">{names.slice(0, MAX_NAMES).join(", ")}{names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : ""}</span>}
        </>
      )}
    </div>
  );
}

/** Mock 07: the system drawn from its architecture model. Pick a level, pan and zoom, and select a box to inspect it. */
export function ArchitectureCanvas({ slug, model, diagrams, version, caption, selected, onSelect, top, diff, notice }: {
  slug: string; model: ArchModel; diagrams: DiagramEntry[]; version: number | null; caption?: ReactNode;
  selected: string | null; onSelect: (node: CanvasNode | null) => void;
  /** Extra controls for the top bar, between the caption and the Source switch. */
  top?: ReactNode;
  /** What to tint: the result of a comparison, with the date it was compared with. */
  diff?: { result: ModelDiff; label: string } | null;
  /** Shown in place of the drawing while the model to draw is not there yet (a baseline loading or failing). */
  notice?: ReactNode;
}) {
  const deployment = diagrams.find((d) => /deploy/i.test(d.level));
  const [level, setLevel] = useState<Shown>("containers");
  const [source, setSource] = useState(false);
  const [full, setFull] = useState(false);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const drawn: Level | null = level === "deployment" ? null : level;
  const laid = useMemo(() => { const g = drawn && canvasGraph(model, drawn); return g ? layoutGraph(g) : null; }, [model, drawn]);
  const picture = level === "deployment" ? deployment : undefined;
  // The suite's picture of the level shown, for its Mermaid source.
  const levelEntry = picture ?? diagrams.find((d) => (level === "context" ? /context/i : /container/i).test(d.level));

  const fit = useCallback(() => {
    const el = host.current;
    if (!el || !laid) return;
    const scale = fitScale(laid, { width: el.clientWidth - 24, height: el.clientHeight - 24 });
    setView({ scale, x: (el.clientWidth - laid.width * scale) / 2, y: (el.clientHeight - laid.height * scale) / 2 });
  }, [laid]);
  useEffect(() => { fit(); }, [fit, full]);
  // An older baseline has no pictures of its own, so its Deployment level is gone.
  useEffect(() => { if (level === "deployment" && !deployment) setLevel("containers"); }, [level, deployment]);
  useLayer(full, () => setFull(false));

  /** Zoom about a point of the viewport (the pointer, or its centre for the buttons). */
  const zoom = (factor: number, at?: { x: number; y: number }) => setView((v) => {
    const el = host.current;
    const p = at ?? { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 };
    const scale = clamp(v.scale * factor);
    const k = scale / v.scale;
    return { scale, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
  });

  return (
    <div className={`canvas ${full ? "full" : ""}`}>
      <div className="canvas-top">
        <span className="muted">{caption}</span>
        <span className="fill" />
        {top}
        {levelEntry && (
          <label className="switch" title="Show the Mermaid source the Architecture Suite wrote for this diagram">
            Source<input type="checkbox" role="switch" checked={source} onChange={(e) => setSource(e.target.checked)} /><span aria-hidden />
          </label>
        )}
      </div>
      {diff && !notice && <Legend result={diff.result} label={diff.label} />}
      <div className="canvas-view" data-own-zoom ref={host}
        onWheel={(e) => { if (!laid || source) return; const r = e.currentTarget.getBoundingClientRect(); zoom(e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step, { x: e.clientX - r.left, y: e.clientY - r.top }); }}
        onPointerDown={(e) => { if (!laid || source || e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          drag.current = { x: e.clientX, y: e.clientY, moved: true };
          setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }}
        onPointerUp={() => { const d = drag.current; drag.current = null; if (d && !d.moved) onSelect(null); }}>
        {notice ? notice : source && levelEntry ? <Source slug={slug} entry={levelEntry} version={version} />
          : picture ? <Picture slug={slug} entry={picture} version={version} />
          : level === "deployment" ? <p className="muted pad">No deployment diagram was generated for this system.</p>
          : !laid ? <p className="muted pad">The model has nothing to draw at this level.</p>
          : (
            <svg className="canvas-svg" role="group" aria-label={`${LEVELS.find((l) => l.id === level)?.label} diagram`}>
              <defs>
                <marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" />
                </marker>
              </defs>
              <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                {laid.boundary && (
                  <>
                    <rect className="canvas-boundary" x={laid.boundary.x} y={laid.boundary.y} width={laid.boundary.width} height={laid.boundary.height} rx={10} />
                    <text className="canvas-boundary-name" x={laid.boundary.x + laid.boundary.width / 2} y={laid.boundary.y + 20} textAnchor="middle">{laid.boundary.name}</text>
                  </>
                )}
                {laid.edges.map((e) => {
                  const mid = e.points[Math.floor(e.points.length / 2)];
                  return (
                    <g key={e.id} className={`canvas-edge ${selected && (e.from === selected || e.to === selected) ? "on" : ""} ${tint(diff, e.id, "Edges")}`}>
                      <path d={path(e.points)} markerEnd="url(#canvas-arrow)" />
                      {e.label && <text x={mid.x} y={mid.y - 7} textAnchor="middle">{e.label.length > 16 ? `${e.label.slice(0, 15)}…` : e.label}</text>}
                    </g>
                  );
                })}
                {laid.nodes.map((n) => (
                  <foreignObject key={n.id} x={n.x} y={n.y} width={n.width} height={n.height}>
                    <button className={`canvas-node ${n.id === selected ? "on" : ""} ${n.external || n.kind === "person" ? "outside" : ""} ${tint(diff, n.id, "")}`} aria-pressed={n.id === selected}
                      title={n.description || n.name} onPointerDown={(e) => e.stopPropagation()} onClick={() => onSelect(n.id === selected ? null : n)}>
                      {icon(n)}<strong>{n.name}</strong><span>{n.technology || KIND[n.kind]}</span>
                    </button>
                  </foreignObject>
                ))}
              </g>
            </svg>
          )}
      </div>
      <div className="canvas-bottom">
        <div className="segmented compact" role="tablist" aria-label="Diagram level">
          {LEVELS.filter((l) => l.id !== "deployment" || deployment).map((l) => (
            <button key={l.id} role="tab" aria-selected={level === l.id} className={level === l.id ? "on" : ""} onClick={() => { setLevel(l.id); onSelect(null); }}>{l.label}</button>
          ))}
        </div>
        <span className="fill" />
        {laid && !source && (
          <div className="canvas-zoom">
            <button className="icon-button" aria-label="Zoom out" onClick={() => zoom(1 / ZOOM.step)}><Minus size={16} aria-hidden /></button>
            <span>{Math.round(view.scale * 100)}%</span>
            <button className="icon-button" aria-label="Zoom in" onClick={() => zoom(ZOOM.step)}><Plus size={16} aria-hidden /></button>
            <button onClick={fit}>Fit</button>
          </div>
        )}
        <button className="icon-button" aria-label={full ? "Leave full view" : "Full view"} title={full ? "Leave full view (Esc)" : "Full view"} onClick={() => setFull(!full)}>
          {full ? <Minimize size={16} aria-hidden /> : <Maximize size={16} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
