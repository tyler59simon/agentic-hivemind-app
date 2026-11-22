// The board of a canvas (NS-7C): an infinite surface of cards and edges in plain DOM. The world is one element moved with a
// CSS transform, so panning and zooming never draw a card again; cards and edges are memoized and only the ones a gesture
// changes get new objects. A gesture (a drag, a resize, a join) shows a preview while it runs and hands the board to
// `onCommit` once, when it ends, so it is one step of the document's history.
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { RichContext } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { NoteCardDialog } from "../hmdoc/blocks/EmbedDialogs";
import type { Pictures } from "../notes/PageView";
import { useWorkspace } from "../../workspace/store";
import { EdgesLayer } from "./Edges";
import { FilePicker } from "./FilePicker";
import {
  addEdge, addNode, anchor, connectProblem, dangling, fitView, inside, moveNodes, nearestSide, PRESETS, removeItems, resizedBox, resizeNode, setEdge, setNode,
  SIZES, zoomAt, type Canvas, type CanvasNode, type NewNode, type Point, type Side, type View,
} from "./model";
import { EnvContext, isWebUrl, MEM_PREFIX, NodeView, type BoardEnv, type NodeApi } from "./nodes/NodeView";
import { registerBoard, type TreeFile } from "./treeDrop";

export interface CanvasBoardProps {
  canvas: Canvas;
  readOnly: boolean;
  ctx: RichContext;
  /** Where the pictures of text cards load from. */
  pictures: Pictures;
  /** The id of the board's notebook: only its own pages can be dropped on the board. */
  notebook: string;
  /** The board after one gesture or edit: one step of the history. */
  onCommit(next: Canvas): void;
  onUndo(): void;
  onRedo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** Open a file card's file in a tab. */
  onOpenFile(path: string): void;
}

type Selection = { nodes: string[]; edge: string | null };
const NONE: Selection = { nodes: [], edge: null };
const STEP = 1.25;
/** A press that moves less than this many pixels is a click, not a drag. */
const SLOP = 3;

type Gesture =
  | { kind: "pan"; sx: number; sy: number; from: View; moved: boolean }
  | { kind: "move"; sx: number; sy: number; ids: Set<string>; base: Canvas; moved: boolean; narrow: string | null; last: Canvas | null }
  | { kind: "resize"; sx: number; sy: number; id: string; corner: string; base: Canvas; last: Canvas | null }
  | { kind: "link"; from: string; side: Side };

const NodesLayer = memo(function NodesLayer({ nodes, selected, editing }: { nodes: CanvasNode[]; selected: ReadonlySet<string>; editing: string | null }) {
  const single = selected.size === 1;
  return <>{nodes.map((n) => <NodeView key={n.id} node={n} selected={selected.has(n.id)} editing={editing === n.id} handles={single && selected.has(n.id)} />)}</>;
});

const inField = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("textarea, input");

export function CanvasBoard(props: CanvasBoardProps) {
  const { canvas, readOnly, ctx } = props;
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [preview, setPreview] = useState<Canvas | null>(null);
  const [sel, setSel] = useState<Selection>(NONE);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [joining, setJoining] = useState<{ from: Point; to: Point } | null>(null);
  const [dialog, setDialog] = useState<"file" | "note" | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // Which edit is open, read synchronously: an edit that has ended ignores the blur its own removal can cause.
  const editingNow = useRef<{ node: string | null; edge: string | null }>({ node: null, edge: null });
  const shown = preview ?? canvas;
  const nodeIds = useMemo(() => new Set(shown.nodes.map((n) => n.id)), [shown.nodes]);
  const selected = useMemo(() => new Set(sel.nodes.filter((id) => nodeIds.has(id))), [sel.nodes, nodeIds]);
  const edgeSelected = sel.edge && shown.edges.some((e) => e.id === sel.edge) ? sel.edge : null;

  const latest = useRef({ view, canvas, sel: selected, edge: edgeSelected, readOnly, props, shown });
  latest.current = { view, canvas, sel: selected, edge: edgeSelected, readOnly, props, shown };

  // Show every card when the board first opens, once the pane has a size.
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (box) setView(fitView(canvas.nodes, box.width, box.height));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A change that did not come from a gesture here (undo, a merge, source edits) ends whatever was under way.
  useEffect(() => {
    gesture.current = null;
    setPreview(null);
    setJoining(null);
  }, [canvas]);

  const centre = (): Point => {
    const box = root.current?.getBoundingClientRect();
    return toCanvas(box ? box.left + box.width / 2 : 0, box ? box.top + box.height / 2 : 0);
  };
  const toCanvas = (clientX: number, clientY: number): Point => {
    const box = root.current?.getBoundingClientRect();
    const v = latest.current.view;
    return { x: (clientX - (box?.left ?? 0) - v.x) / v.k, y: (clientY - (box?.top ?? 0) - v.y) / v.k };
  };

  const commit = (next: Canvas) => { if (!latest.current.readOnly) latest.current.props.onCommit(next); };
  const startEdit = (id: string) => { editingNow.current = { node: id, edge: null }; setEditingEdge(null); setEditing(id); };
  const startEdgeEdit = (id: string) => { editingNow.current = { node: null, edge: id }; setEditing(null); setEditingEdge(id); };

  /** Put a card on the board, centred on `at` (the middle of the pane by default), select it, and open it for editing when
   *  it holds text. */
  const add = (node: NewNode, size: keyof typeof SIZES, at?: Point) => {
    const p = at ?? centre();
    const { width, height } = SIZES[size];
    const made = addNode(latest.current.canvas, { ...node, x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2), width, height });
    commit(made.canvas);
    setSel({ nodes: [made.id], edge: null });
    if (node.type === "text" || (node.type === "link" && !node.url) || node.type === "group") startEdit(made.id);
  };
  const addFile = (path: string, at?: Point) => add({ type: "file", file: path }, isPicture(path) ? "picture" : "file", at);

  const finish = (id: string, patch: Partial<CanvasNode> | null) => {
    if (editingNow.current.node !== id) return;
    editingNow.current = { node: null, edge: null };
    setEditing(null);
    const node = latest.current.canvas.nodes.find((n) => n.id === id);
    if (!patch || !node) return;
    if (Object.keys(patch).some((k) => patch[k] !== node[k])) commit(setNode(latest.current.canvas, id, patch));
  };
  const finishEdge = (id: string, label: string | null) => {
    if (editingNow.current.edge !== id) return;
    editingNow.current = { node: null, edge: null };
    setEditingEdge(null);
    const edge = latest.current.canvas.edges.find((e) => e.id === id);
    if (label === null || !edge) return;
    if ((label || undefined) !== edge.label) commit(setEdge(latest.current.canvas, id, { label: label || undefined }));
  };

  const api = useMemo<NodeApi>(() => ({
    finish: (id, patch) => finish(id, patch),
    follow: (target, split) => latest.current.props.ctx.openPage(target, split),
    openFile: (path) => latest.current.props.onOpenFile(path),
    openUrl: (url) => { if (isWebUrl(url)) openUrl(url).catch(() => undefined); },
    openNote: (ref) => useWorkspace.getState().openNote(ref, {}),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const known = useMemo(() => new Set((ctx.notebook?.files ?? []).map((f) => f.toLowerCase())), [ctx.notebook?.files]);
  const env = useMemo<BoardEnv>(() => ({ readOnly, ctx, pictures: props.pictures, known, api }), [readOnly, ctx, props.pictures, known, api]);

  // A page dragged from the notebook tree and let go over the board.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    return registerBoard(el, (file: TreeFile, at) => {
      const L = latest.current;
      if (L.readOnly) { L.props.ctx.fail("This canvas is read-only, so nothing was added."); return; }
      if (file.notebook !== L.props.notebook) { L.props.ctx.fail("Only files of this notebook can be put on its canvas."); return; }
      addFile(file.path, toCanvas(at.x, at.y));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom with Ctrl and the wheel, pan with the wheel alone. A listener of its own, since React's wheel handler cannot cancel
  // the page's own scrolling.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (inField(e.target) || (e.target as HTMLElement).closest?.("[data-canvas-ui]")) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, v.k * Math.exp(-e.deltaY * 0.002), e.clientX - box.left, e.clientY - box.top));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // The gesture under way follows the pointer wherever it goes, and ends in one change (or none).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      // A button already let go means the end was missed (the window lost it): the gesture is over.
      if (e.buttons === 0 && e.pointerType !== "touch") { end(e, true); return; }
      const L = latest.current;
      if (g.kind === "pan") {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < SLOP) return;
        g.moved = true;
        setView({ ...g.from, x: g.from.x + e.clientX - g.sx, y: g.from.y + e.clientY - g.sy });
      } else if (g.kind === "move") {
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < SLOP) return;
        g.moved = true;
        g.last = moveNodes(g.base, g.ids, (e.clientX - g.sx) / L.view.k, (e.clientY - g.sy) / L.view.k);
        setPreview(g.last);
      } else if (g.kind === "resize") {
        const n = g.base.nodes.find((x) => x.id === g.id);
        if (!n) return;
        g.last = resizeNode(g.base, g.id, resizedBox(n, g.corner, (e.clientX - g.sx) / L.view.k, (e.clientY - g.sy) / L.view.k));
        setPreview(g.last);
      } else {
        const n = L.canvas.nodes.find((x) => x.id === g.from);
        if (n) setJoining({ from: anchor(n, g.side), to: toCanvas(e.clientX, e.clientY) });
      }
    };
    const end = (e: PointerEvent, cancelled: boolean) => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      const L = latest.current;
      if (g.kind === "pan") {
        if (!g.moved && !cancelled) { setSel(NONE); }
      } else if (g.kind === "move") {
        setPreview(null);
        if (cancelled) return;
        if (g.moved && g.last) commit(g.last);
        else if (g.narrow) setSel({ nodes: [g.narrow], edge: null });
      } else if (g.kind === "resize") {
        setPreview(null);
        if (!cancelled && g.last) commit(g.last);
      } else {
        setJoining(null);
        if (cancelled) return;
        const id = (e.target as HTMLElement | null)?.closest?.("[data-node-id]")?.getAttribute("data-node-id");
        const to = id ? L.canvas.nodes.find((n) => n.id === id) : undefined;
        const from = L.canvas.nodes.find((n) => n.id === g.from);
        if (!to || !from) return;
        const toSide = nearestSide(to, toCanvas(e.clientX, e.clientY));
        const problem = connectProblem(L.canvas, from.id, to.id, g.side, toSide);
        if (problem) { if (from.id !== to.id) L.props.ctx.fail(problem); return; }
        const made = addEdge(L.canvas, from.id, to.id, g.side, toSide);
        if (made) { commit(made.canvas); setSel({ nodes: [], edge: made.id }); }
      }
    };
    const up = (e: PointerEvent) => end(e, false);
    const cancel = (e: PointerEvent) => end(e, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-canvas-ui]") || inField(t)) return;
    const L = latest.current;
    root.current?.focus({ preventScroll: true });
    const nodeEl = t.closest<HTMLElement>("[data-node-id]");
    const edgeEl = t.closest<HTMLElement>("[data-edge-id]");
    const handle = t.closest<HTMLElement>("[data-handle]")?.dataset.handle as Side | undefined;
    const corner = t.closest<HTMLElement>("[data-resize]")?.dataset.resize;
    const id = nodeEl?.dataset.nodeId;
    const at = { sx: e.clientX, sy: e.clientY };
    const node = id ? L.canvas.nodes.find((n) => n.id === id) : undefined;
    if (e.button === 1 || (!node && !edgeEl)) {
      gesture.current = { kind: "pan", ...at, from: L.view, moved: false };
      return;
    }
    if (!node) {
      // An edge: select it. Its label is edited by double-clicking it.
      setSel({ nodes: [], edge: edgeEl!.dataset.edgeId! });
      return;
    }
    if (handle && !L.readOnly) {
      gesture.current = { kind: "link", from: node.id, side: handle };
      setJoining({ from: anchor(node, handle), to: toCanvas(e.clientX, e.clientY) });
      return;
    }
    if (corner && !L.readOnly) {
      gesture.current = { kind: "resize", ...at, id: node.id, corner, base: L.canvas, last: null };
      return;
    }
    const was = L.sel.has(node.id);
    let nodes = [...L.sel];
    if (e.shiftKey) {
      nodes = was ? nodes.filter((n) => n !== node.id) : [...nodes, node.id];
      setSel({ nodes, edge: null });
      if (was) return;
    } else if (!was) {
      nodes = [node.id];
      setSel({ nodes, edge: null });
    }
    if (L.readOnly) return;
    // A group takes the cards inside it along.
    const ids = new Set(nodes);
    for (const n of nodes) for (const inner of inside(L.canvas, n)) ids.add(inner);
    gesture.current = { kind: "move", ...at, ids, base: L.canvas, moved: false, narrow: was && !e.shiftKey && nodes.length > 1 ? node.id : null, last: null };
  };

  const doubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-canvas-ui]") || inField(t)) return;
    const L = latest.current;
    const id = t.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const node = id ? L.canvas.nodes.find((n) => n.id === id) : undefined;
    const edgeId = t.closest<HTMLElement>("[data-edge-id]")?.dataset.edgeId;
    if (node) {
      if (node.type === "file" && node.file) L.props.onOpenFile(node.file.replace(/\\/g, "/"));
      else if (node.type === "link" && node.url?.startsWith(MEM_PREFIX)) useWorkspace.getState().openNote(node.url.slice(MEM_PREFIX.length), {});
      else if (!L.readOnly && (node.type === "text" || node.type === "link" || node.type === "group")) startEdit(node.id);
    } else if (edgeId) {
      if (!L.readOnly) startEdgeEdit(edgeId);
    } else if (!L.readOnly) add({ type: "text", text: "" }, "text", toCanvas(e.clientX, e.clientY));
  };

  const removeSelected = () => {
    const L = latest.current;
    if (L.readOnly || (!L.sel.size && !L.edge)) return;
    commit(removeItems(L.canvas, L.sel, new Set(L.edge ? [L.edge] : [])));
    setSel(NONE);
  };

  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (inField(e.target) || (e.target as HTMLElement).closest("[data-canvas-ui]")) return;
    const L = latest.current;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) L.props.onRedo(); else L.props.onUndo(); }
    else if (mod && key === "y") { e.preventDefault(); L.props.onRedo(); }
    else if (mod && key === "a") { e.preventDefault(); setSel({ nodes: L.canvas.nodes.map((n) => n.id), edge: null }); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    else if (e.key === "Escape") { gesture.current = null; setPreview(null); setJoining(null); setSel(NONE); }
    else if ((e.key === "Enter" || e.key === "F2") && !L.readOnly) {
      const [only] = [...L.sel];
      const node = L.sel.size === 1 ? L.canvas.nodes.find((n) => n.id === only) : undefined;
      if (node && (node.type === "text" || node.type === "link" || node.type === "group")) { e.preventDefault(); startEdit(node.id); }
      else if (!L.sel.size && L.edge) { e.preventDefault(); startEdgeEdit(L.edge); }
    }
  };

  const zoomBy = (factor: number) => {
    const box = root.current?.getBoundingClientRect();
    setView((v) => zoomAt(v, v.k * factor, (box?.width ?? 0) / 2, (box?.height ?? 0) / 2));
  };
  const fit = () => {
    const box = root.current?.getBoundingClientRect();
    if (box) setView(fitView(latest.current.canvas.nodes, box.width, box.height));
  };

  /** Colour what is selected: a preset number, or none. One step. */
  const colour = (color: string | undefined) => {
    const L = latest.current;
    let next = L.canvas;
    for (const id of L.sel) next = setNode(next, id, { color });
    if (L.edge) next = setEdge(next, L.edge, { color });
    if (next !== L.canvas) commit(next);
  };
  const hasSelection = selected.size > 0 || !!edgeSelected;
  const missing = dangling(shown).length;

  const world: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, ["--k" as string]: view.k };
  const percent = `${Math.round(view.k * 100)}%`;
  return (
    <div ref={root} className="canvas-board" tabIndex={0} role="application" aria-label="Canvas board" onPointerDown={down} onDoubleClick={doubleClick} onKeyDown={keys}>
      <EnvContext.Provider value={env}>
        <div className="canvas-world" style={world}>
          <EdgesLayer nodes={shown.nodes} edges={shown.edges} selected={edgeSelected} editing={editingEdge} onLabel={finishEdge} />
          <NodesLayer nodes={shown.nodes} selected={selected} editing={editing} />
          {joining && <svg className="canvas-edges" width="1" height="1" aria-hidden><path className="canvas-joining" d={`M${joining.from.x} ${joining.from.y}L${joining.to.x} ${joining.to.y}`} /></svg>}
        </div>
      </EnvContext.Provider>
      <div className="canvas-tools" data-canvas-ui role="toolbar" aria-label="Canvas tools">
        {!readOnly && (
          <>
            <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (Ctrl+Z)">Undo</button>
            <button type="button" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (Ctrl+Y)">Redo</button>
            <span className="canvas-sep" />
            <button type="button" onClick={() => add({ type: "text", text: "" }, "text")} title="Add a text card">Text</button>
            <button type="button" onClick={() => setDialog("file")} title="Add a page, picture or PDF of this notebook">File</button>
            <button type="button" onClick={() => add({ type: "link", url: "" }, "link")} title="Add a link card">Link</button>
            <button type="button" onClick={() => add({ type: "group" }, "group")} title="Add a group">Group</button>
            <button type="button" onClick={() => setDialog("note")} title="Add a Memory note">Memory note</button>
            <span className="canvas-sep" />
          </>
        )}
        <button type="button" onClick={() => zoomBy(1 / STEP)} title="Zoom out" aria-label="Zoom out">−</button>
        <span className="canvas-zoom" aria-live="polite" aria-label="Zoom level">{percent}</span>
        <button type="button" onClick={() => zoomBy(STEP)} title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} title="Fit every card in the pane">Fit</button>
        {!readOnly && hasSelection && (
          <>
            <span className="canvas-sep" />
            {Object.entries(PRESETS).map(([n, name]) => <button key={n} type="button" className={`canvas-swatch canvas-c canvas-c-${name}`} title={`Colour ${name}`} aria-label={`Colour ${name}`} onClick={() => colour(n)} />)}
            <button type="button" onClick={() => colour(undefined)} title="Remove the colour">No colour</button>
            <button type="button" onClick={removeSelected} title="Delete the selection (Delete)">Delete</button>
          </>
        )}
      </div>
      {missing > 0 && <div className="canvas-note muted small" data-canvas-ui>{missing} {missing === 1 ? "edge joins" : "edges join"} a card that is not on the board. {missing === 1 ? "It is" : "They are"} kept in the file and not drawn.</div>}
      {dialog === "file" && <FilePicker files={ctx.notebook?.files ?? []} onClose={() => setDialog(null)} onPick={(path) => { setDialog(null); addFile(path); }} />}
      {dialog === "note" && (
        <NoteCardDialog initial={null} onClose={() => setDialog(null)}
          onPick={(attrs) => { setDialog(null); add({ type: "link", url: `${MEM_PREFIX}${String(attrs.ref)}` }, "link"); }} />
      )}
    </div>
  );
}
