import { useEffect, useRef, useState } from "react";
import Sigma from "sigma";
import type { LinkGraph } from "../../lib/lm";
import { PreviewCard } from "../preview/HoverPreview";
import { toGraphology } from "./graphData";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

/** A sigma.js drawing of notes and their links. Hover highlights neighbours and previews the note;
 *  click opens it (Ctrl/Cmd+click in a split). */
export function GraphCanvas({ data, focus, onOpen, compact }: {
  data: LinkGraph; focus?: string; onOpen: (ref: string, title: string, split: boolean) => void; compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ ref: string; x: number; y: number } | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    if (!host.current) return;
    const graph = toGraphology(data);
    let hovered: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const [fg, muted, border, accent] = [css("--fg"), css("--muted"), css("--border"), css("--accent")];
    const sigma = new Sigma(graph, host.current, {
      settings: {
        renderEdgeLabels: false, itemSizesReference: "screen", autoRescale: true,
        labelRenderedSizeThreshold: compact ? 4 : 6, labelDensity: compact ? 1 : 0.6, stagePadding: compact ? 24 : 48,
      },
      nodeReducer: (node, display) => {
        const out: Partial<typeof display> = { labelColor: fg };
        if (node === focus) { out.highlighted = true; out.labelVisibility = "visible"; }
        if (graph.getNodeAttribute(node, "status") !== "active") out.opacity = 0.5;
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
      const rect = host.current!.getBoundingClientRect();
      timer = setTimeout(() => setPreview({ ref: node, x: Math.min(rect.left + event.x + 12, window.innerWidth - 380), y: rect.top + event.y + 12 }), 400);
    });
    sigma.on("leaveNode", () => {
      hovered = null;
      if (timer) clearTimeout(timer);
      setPreview(null);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("clickNode", ({ node, event }) => {
      const original = event.original as MouseEvent;
      open.current(node, graph.getNodeAttribute(node, "label"), original.ctrlKey || original.metaKey);
    });
    // Re-fit when the pane is resized (splits, side panels, window size).
    const resize = new ResizeObserver(() => { sigma.resize(); sigma.refresh(); });
    resize.observe(host.current);
    return () => { resize.disconnect(); if (timer) clearTimeout(timer); sigma.kill(); };
  }, [data, focus, compact]);

  return (
    <div className={`graph-canvas ${compact ? "compact" : ""}`}>
      <div className="graph-host" ref={host} />
      {preview && <PreviewCard refId={preview.ref} x={preview.x} y={preview.y} />}
    </div>
  );
}
