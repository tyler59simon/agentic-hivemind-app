import { useEffect, useRef, useState } from "react";
import Sigma from "sigma";
import { systemPalette, useForcedColors } from "../../lib/forcedColors";
import { useReducedMotion } from "../../lib/motion";
import { useTheme } from "../../lib/theme";
import { PagePreviewCard, PreviewCard } from "../preview/HoverPreview";
import { graphSummary, toGraphology, type UnifiedGraph, type UnifiedNode } from "./graphData";
import { cameraSettings, graphColors } from "./graphLook";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

/** A sigma.js drawing of memory notes and folder notebook pages and their links. Hover highlights neighbours and previews
 *  the node; click opens it (Ctrl/Cmd+click in a split). */
export function GraphCanvas({ data, focus, onOpen, compact, dim }: {
  data: UnifiedGraph; focus?: string; onOpen: (node: UnifiedNode, split: boolean) => void; compact?: boolean;
  /** Nodes drawn as context (greyed) unless hovered or next to the hovered node, e.g. a project's neighbours. */
  dim?: Set<string>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ node: UnifiedNode; x: number; y: number } | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  const theme = useTheme();   // the colours below are read from the theme's tokens
  const forced = useForcedColors();   // in a Windows contrast theme they are the system colours instead
  const reduced = useReducedMotion();   // and the camera does not animate

  useEffect(() => {
    if (!host.current) return;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const graph = toGraphology(data);
    let hovered: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const { fg, muted, border, accent, node: nodeColor, focus: focusColor } = graphColors(forced ? systemPalette() : null, css);
    const sigma = new Sigma(graph, host.current, {
      settings: {
        renderEdgeLabels: false, itemSizesReference: "screen", autoRescale: true,
        labelRenderedSizeThreshold: compact ? 4 : 6, labelDensity: compact ? 1 : 0.6, stagePadding: compact ? 24 : 48,
        ...cameraSettings(reduced),
      },
      nodeReducer: (node, display) => {
        const out: Partial<typeof display> = { labelColor: fg };
        if (nodeColor) out.color = nodeColor;
        if (node === focus) { out.highlighted = true; out.labelVisibility = "visible"; if (focusColor) out.color = focusColor; }
        if (graph.getNodeAttribute(node, "status") !== "active") out.opacity = 0.5;
        if (dim?.has(node) && !(hovered && (node === hovered || graph.areNeighbors(node, hovered)))) { out.color = border; out.labelColor = muted; }
        if (hovered && node !== hovered && !graph.areNeighbors(node, hovered)) { out.color = border; out.labelColor = muted; out.labelVisibility = "hidden"; }
        else if (hovered) out.labelVisibility = "visible";
        return out;
      },
      edgeReducer: (edge, display) => {
        const supersedes = graph.getEdgeAttribute(edge, "kind") === "supersedes";
        const touchesHover = hovered && graph.extremities(edge).includes(hovered);
        return { color: touchesHover ? accent : supersedes ? muted : border, size: touchesHover ? 2 : display.size };
      },
    });
    sigma.on("enterNode", ({ node, event }) => {
      hovered = node;
      sigma.refresh({ skipIndexation: true });
      const found = byId.get(node);
      if (!found || !host.current) return;
      const rect = host.current.getBoundingClientRect();
      timer = setTimeout(() => setPreview({ node: found, x: Math.min(rect.left + event.x + 12, window.innerWidth - 380), y: rect.top + event.y + 12 }), 400);
    });
    sigma.on("leaveNode", () => {
      hovered = null;
      if (timer) clearTimeout(timer);
      setPreview(null);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("clickNode", ({ node, event }) => {
      const found = byId.get(node);
      if (!found) return;
      const original = event.original as MouseEvent;
      open.current(found, original.ctrlKey || original.metaKey);
    });
    // Re-fit when the pane is resized (splits, side panels, window size).
    const resize = new ResizeObserver(() => { sigma.resize(); sigma.refresh(); });
    resize.observe(host.current);
    return () => { resize.disconnect(); if (timer) clearTimeout(timer); setPreview(null); sigma.kill(); };
  }, [data, focus, compact, dim, theme, forced, reduced]);

  return (
    <div className={`graph-canvas ${compact ? "compact" : ""}`}>
      {/* The drawing is a picture to a screen reader. The summary is its name; the shown nodes and their links are in the
          list the graph view offers ("Show as list"), and the local graph in the rail sits under a Connections list. */}
      <div className="graph-host" ref={host} role="img" aria-label={graphSummary(data, compact ? "Local graph" : "Graph")} />
      {preview && (preview.node.kind === "note"
        ? <PreviewCard refId={preview.node.ref} x={preview.x} y={preview.y} />
        : <PagePreviewCard node={preview.node} x={preview.x} y={preview.y} />)}
    </div>
  );
}
