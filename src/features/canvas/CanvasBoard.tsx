// The board of a canvas (NS-7C): an infinite surface of cards and edges in plain DOM. The world is one element moved with a
// CSS transform, so panning and zooming never draw a card again; cards and edges are memoized and only the ones a gesture
// changes get new objects. A gesture (a drag, a resize, a join) shows a preview while it runs and hands the board to
// `onCommit` once, when it ends, so it is one step of the document's history.
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { RichContext } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { NoteCardDialog } from "../hmdoc/blocks/EmbedDialogs";
import type { Pictures } from "../notes/PageView";
import { nudgeOf } from "../../lib/nudge";
import { useWorkspace } from "../../workspace/store";
import { EdgesLayer } from "./Edges";
import { FilePicker } from "./FilePicker";
import {
  addEdge, addNode, anchor, connectProblem, dangling, facing, fitView, moveNodes, nearestSide, PRESETS, readingOrder, removeItems, resizedBox, resizeNode, setEdge, setNode,
  SIZES, withInside, zoomAt, type Box, type Canvas, type CanvasEdge, type CanvasNode, type NewNode, type Point, type Side, type View,
} from "./model";
import { EnvContext, isWebUrl, MEM_PREFIX, NodeView, nodeName, type BoardEnv, type NodeApi } from "./nodes/NodeView";
import { registerBoard, type TreeFile } from "./treeDrop";

export interface CanvasBoardProps {
  canvas: Canvas;
  readOnly: boolean;
  ctx: RichContext;
  /** Where the pictures of text cards load from. */
  pictures: Pictures;
  /** The id of the board's notebook: only its own pages can be dropped on the board. */
  notebook: string;
  /** The board after one gesture or edit: one step of the history. `group` names a run of the same keyboard move or resize, which
   *  the history folds into one step when the presses come close together. */
  onCommit(next: Canvas, group?: string): void;
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

const NodesLayer = memo(function NodesLayer({ nodes, selected, editing, tabStop }: { nodes: CanvasNode[]; selected: ReadonlySet<string>; editing: string | null; tabStop: string | null }) {
  const single = selected.size === 1;
  return <>{nodes.map((n) => <NodeView key={n.id} node={n} selected={selected.has(n.id)} editing={editing === n.id} handles={single && selected.has(n.id)} tabStop={tabStop === n.id} />)}</>;
});

/** The edges as a list, and a form that joins two cards: the way to read, pick and make connections without the drawing and
 *  without dragging from a card's handle to another card (WCAG 2.5.7). */
function ConnectionsPanel({ nodes, edges, readOnly, onPick, onConnect }: {
  nodes: CanvasNode[]; edges: CanvasEdge[]; readOnly: boolean; onPick(edgeId: string): void; onConnect(from: string, to: string): void;
}) {
  const names = new Map(nodes.map((n) => [n.id, nodeName(n).name]));
  const rows = edges.filter((e) => names.has(e.fromNode) && names.has(e.toNode));
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const options = (value: string, set: (v: string) => void, label: string) => (
    <label>{label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a card</option>
        {nodes.map((n) => <option key={n.id} value={n.id}>{nodeName(n).kind}: {names.get(n.id)}</option>)}
      </select>
    </label>
  );
  return (
    <div className="canvas-panel" data-canvas-ui role="group" aria-label="Connections">
      {rows.length
        ? <ul>{rows.map((e) => (
          <li key={e.id}>
            <button type="button" className="link-row" onClick={() => onPick(e.id)}>{names.get(e.fromNode)} to {names.get(e.toNode)}{e.label ? `: ${e.label}` : ""}</button>
          </li>
        ))}</ul>
        : <p className="muted small">No connections.</p>}
      {!readOnly && nodes.length > 1 && (
        <form className="canvas-connect" onSubmit={(e) => { e.preventDefault(); if (from && to) onConnect(from, to); }}>
          {options(from, setFrom, "From")}
          {options(to, setTo, "To")}
          <button type="submit" disabled={!from || !to}>Connect</button>
        </form>
      )}
    </div>
  );
}

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
  const [panel, setPanel] = useState(false);
  // The card the Tab key stops on (a roving tabindex: the arrow keys move between cards), and where focus goes once an edit or
  // a delete has finished and its element is gone: a card's id, or "board".
  const [stop, setStop] = useState<string | null>(null);
  const focusAfter = useRef<string | null>(null);
  // A pointer press is under way: focus it gives a card must not change the selection the press makes itself (Shift+click).
  const pressing = useRef(false);
  const panelId = useId(), hintId = useId();
  const gesture = useRef<Gesture | null>(null);
  // Which edit is open, read synchronously: an edit that has ended ignores the blur its own removal can cause.
  const editingNow = useRef<{ node: string | null; edge: string | null }>({ node: null, edge: null });
  const shown = preview ?? canvas;
  const nodeIds = useMemo(() => new Set(shown.nodes.map((n) => n.id)), [shown.nodes]);
  const selected = useMemo(() => new Set(sel.nodes.filter((id) => nodeIds.has(id))), [sel.nodes, nodeIds]);
  const edgeSelected = sel.edge && shown.edges.some((e) => e.id === sel.edge) ? sel.edge : null;
  // The keyboard walks the cards in reading order: top to bottom, then left to right.
  const order = useMemo(() => readingOrder(canvas.nodes), [canvas.nodes]);
  const tabStop = selected.size === 1 ? [...selected][0] : stop && nodeIds.has(stop) ? stop : order[0]?.id ?? null;

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

  const commit = (next: Canvas, group?: string) => { if (!latest.current.readOnly) latest.current.props.onCommit(next, group); };

  /** Pan the view just far enough to bring `b` (a card's box) into the pane, for a card the keyboard has reached. */
  const reveal = (b: Box) => {
    const pane = root.current?.getBoundingClientRect();
    if (!pane?.width) return;
    setView((v) => {
      const m = 48, l = b.x * v.k + v.x, t = b.y * v.k + v.y, r = l + b.width * v.k, bottom = t + b.height * v.k;
      let { x, y } = v;
      if (r > pane.width - m) x -= r - (pane.width - m);
      if (l + (x - v.x) < m) x += m - (l + (x - v.x));
      if (bottom > pane.height - m) y -= bottom - (pane.height - m);
      if (t + (y - v.y) < m) y += m - (t + (y - v.y));
      return x === v.x && y === v.y ? v : { ...v, x, y };
    });
  };
  /** Focus a card (or the board) without the browser scrolling the pane; the view is moved by `reveal` instead. */
  const focusOn = (id: string) => {
    const el = id === "board" ? root.current : [...(root.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [])].find((n) => n.dataset.nodeId === id);
    el?.focus({ preventScroll: true });
    const node = latest.current.canvas.nodes.find((n) => n.id === id);
    if (node) reveal(node);
  };
  /** Select one card and put the keyboard on it. */
  const goTo = (id: string) => { setSel({ nodes: [id], edge: null }); setStop(id); focusOn(id); };

  // Focus that waits for what ended an edit or removed a card: the textarea or the card is gone once the board has drawn again.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || editing || editingEdge) return;
    focusAfter.current = null;
    focusOn(id);
  }); // eslint-disable-line react-hooks/exhaustive-deps
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

  const finish = (id: string, patch: Partial<CanvasNode> | null, byKey?: boolean) => {
    if (editingNow.current.node !== id) return;
    editingNow.current = { node: null, edge: null };
    if (byKey) focusAfter.current = id;
    setEditing(null);
    const node = latest.current.canvas.nodes.find((n) => n.id === id);
    if (!patch || !node) return;
    if (Object.keys(patch).some((k) => patch[k] !== node[k])) commit(setNode(latest.current.canvas, id, patch));
  };
  const finishEdge = (id: string, label: string | null, byKey?: boolean) => {
    if (editingNow.current.edge !== id) return;
    editingNow.current = { node: null, edge: null };
    if (byKey) focusAfter.current = "board";
    setEditingEdge(null);
    const edge = latest.current.canvas.edges.find((e) => e.id === id);
    if (label === null || !edge) return;
    if ((label || undefined) !== edge.label) commit(setEdge(latest.current.canvas, id, { label: label || undefined }));
  };

  const api = useMemo<NodeApi>(() => ({
    finish: (id, patch, byKey) => finish(id, patch, byKey),
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
    const up = (e: PointerEvent) => { pressing.current = false; end(e, false); };
    const cancel = (e: PointerEvent) => { pressing.current = false; end(e, true); };
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
    const nodeEl = t.closest<HTMLElement>("[data-node-id]");
    pressing.current = true;
    (nodeEl ?? root.current)?.focus({ preventScroll: true });
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
    const ids = withInside(L.canvas, nodes);
    gesture.current = { kind: "move", ...at, ids, base: L.canvas, moved: false, narrow: was && !e.shiftKey && nodes.length > 1 ? node.id : null, last: null };
  };

  /** What a double-click on a card does, and Enter or F2 on one: open a file or a Memory note, or edit what the card says. */
  const activate = (node: CanvasNode) => {
    const L = latest.current;
    if (node.type === "file" && node.file) L.props.onOpenFile(node.file.replace(/\\/g, "/"));
    else if (node.type === "link" && node.url?.startsWith(MEM_PREFIX)) useWorkspace.getState().openNote(node.url.slice(MEM_PREFIX.length), {});
    else if (!L.readOnly && (node.type === "text" || node.type === "link" || node.type === "group")) startEdit(node.id);
  };

  const doubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-canvas-ui]") || inField(t)) return;
    const L = latest.current;
    const id = t.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const node = id ? L.canvas.nodes.find((n) => n.id === id) : undefined;
    const edgeId = t.closest<HTMLElement>("[data-edge-id]")?.dataset.edgeId;
    if (node) {
      activate(node);
    } else if (edgeId) {
      if (!L.readOnly) startEdgeEdit(edgeId);
    } else if (!L.readOnly) add({ type: "text", text: "" }, "text", toCanvas(e.clientX, e.clientY));
  };

  const removeSelected = () => {
    const L = latest.current;
    if (L.readOnly || (!L.sel.size && !L.edge)) return;
    // Keep the keyboard where it was: on the card after the first one removed in reading order, else the one before, else the board.
    const rest = order.filter((n) => !L.sel.has(n.id));
    const first = order.findIndex((n) => L.sel.has(n.id));
    const next = rest.find((n) => order.indexOf(n) > first) ?? rest[rest.length - 1];
    focusAfter.current = next && L.sel.size ? next.id : "board";
    commit(removeItems(L.canvas, L.sel, new Set(L.edge ? [L.edge] : [])));
    setSel(NONE);
  };

  /** A keyboard move or resize (Ctrl+Arrow, Ctrl+Shift+Arrow) of the cards `ids`: the same model change as a drag, as one commit,
   *  and a run of presses of one kind is one step of the history. */
  const nudge = (ids: string[], by: NonNullable<ReturnType<typeof nudgeOf>>) => {
    const L = latest.current;
    if (L.readOnly || !ids.length) return;
    if (by.kind === "move") {
      commit(moveNodes(L.canvas, withInside(L.canvas, ids), by.dx, by.dy), "key-move");
      const n = L.canvas.nodes.find((x) => x.id === ids[0]);
      if (n) reveal({ ...n, x: n.x + by.dx, y: n.y + by.dy });
    } else if (ids.length === 1) {
      const n = L.canvas.nodes.find((x) => x.id === ids[0]);
      if (!n) return;
      const box = resizedBox(n, "se", by.dx, by.dy);
      commit(resizeNode(L.canvas, n.id, box), "key-resize");
      reveal(box);
    }
  };

  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (inField(t) || t.closest("[data-canvas-ui]")) return;
    const L = latest.current;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    // What acts on a card is for the card or the board having focus, not for a button or link inside a card (Enter on "Open in
    // browser" opens the address and does not also edit the card).
    const focused = t.hasAttribute("data-node-id") ? t.dataset.nodeId : undefined;
    const direct = t === root.current || !!focused;
    const nudged = direct ? nudgeOf(e) : null;
    const walk: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) L.props.onRedo(); else L.props.onUndo(); }
    else if (mod && key === "y") { e.preventDefault(); L.props.onRedo(); }
    else if (mod && key === "a") { e.preventDefault(); setSel({ nodes: L.canvas.nodes.map((n) => n.id), edge: null }); }
    else if (nudged) { e.preventDefault(); nudge(L.sel.size ? [...L.sel] : focused ? [focused] : [], nudged); }
    // Arrow keys move between cards in reading order (down and right go on, up and left go back); Home and End go to the ends.
    else if (direct && !mod && !e.altKey && !e.shiftKey && (e.key in walk || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      if (!order.length) return;
      const here = order.findIndex((n) => n.id === (focused ?? (L.sel.size === 1 ? [...L.sel][0] : stop)));
      const to = e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : Math.min(order.length - 1, Math.max(0, here < 0 ? 0 : here + walk[e.key]));
      goTo(order[to].id);
    }
    else if (direct && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeSelected(); }
    else if (e.key === "Escape") {
      // Escape used here (a gesture, a selection) is not for focus mode too.
      if (gesture.current || preview || joining || L.sel.size || L.edge) e.preventDefault();
      gesture.current = null; setPreview(null); setJoining(null); setSel(NONE);
    }
    else if (direct && (e.key === "Enter" || e.key === "F2")) {
      const [only] = [...L.sel];
      const node = L.canvas.nodes.find((n) => n.id === (focused ?? (L.sel.size === 1 ? only : undefined)));
      if (node) { e.preventDefault(); activate(node); }
      else if (!L.sel.size && L.edge && !L.readOnly) { e.preventDefault(); startEdgeEdit(L.edge); }
    }
  };

  /** A card has the keyboard focus, however it got it (Tab, an arrow key, a click): it is the Tab stop, it is selected, and it is
   *  brought into view. The browser's own scrolling of the pane is undone: the board moves by its transform. */
  const gotFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const id = el.getAttribute("data-node-id");
    if (!id || el.closest("[data-canvas-ui]")) return;
    if (root.current) { root.current.scrollLeft = 0; root.current.scrollTop = 0; }
    setStop(id);
    if (pressing.current) return;
    const L = latest.current;
    const node = L.canvas.nodes.find((n) => n.id === id);
    if (!node) return;
    if (!L.sel.has(id)) setSel({ nodes: [id], edge: null });
    reveal(node);
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
    <div ref={root} className="canvas-board" data-own-zoom tabIndex={tabStop ? -1 : 0} role="application" aria-label="Canvas board" aria-describedby={hintId}
      onPointerDown={down} onDoubleClick={doubleClick} onKeyDown={keys} onFocus={gotFocus}>
      <p id={hintId} className="visually-hidden">
        Arrow keys move between cards in reading order. Enter or F2 opens or edits the card. Ctrl or Cmd with an arrow key moves it,
        and with Shift as well resizes it. Delete removes it.
      </p>
      <EnvContext.Provider value={env}>
        <div className="canvas-world" style={world}>
          <EdgesLayer nodes={shown.nodes} edges={shown.edges} selected={edgeSelected} editing={editingEdge} onLabel={finishEdge} />
          <NodesLayer nodes={shown.nodes} selected={selected} editing={editing} tabStop={tabStop} />
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
        <span className="canvas-zoom" role="status" aria-label="Zoom level">{percent}</span>
        <button type="button" onClick={() => zoomBy(STEP)} title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} title="Fit every card in the pane">Fit</button>
        {/* The edges are drawn in an SVG a screen reader skips and a keyboard cannot select. This is their list, and the way to join
            two cards without dragging from one card's handle to the other. */}
        <button type="button" aria-expanded={panel} aria-controls={panelId} onClick={() => setPanel((v) => !v)}>Connections</button>
        {!readOnly && hasSelection && (
          <>
            <span className="canvas-sep" />
            {Object.entries(PRESETS).map(([n, name]) => <button key={n} type="button" className={`canvas-swatch canvas-c canvas-c-${name}`} title={`Colour ${name}`} aria-label={`Colour ${name}`} onClick={() => colour(n)} />)}
            <button type="button" onClick={() => colour(undefined)} title="Remove the colour">No colour</button>
            <button type="button" onClick={removeSelected} title="Delete the selection (Delete)">Delete</button>
          </>
        )}
      </div>
      {panel && (
        <div id={panelId} className="canvas-panel-host" data-canvas-ui>
          <ConnectionsPanel nodes={canvas.nodes} edges={canvas.edges} readOnly={readOnly}
            onPick={(id) => { setSel({ nodes: [], edge: id }); root.current?.focus({ preventScroll: true }); }}
            onConnect={(from, to) => {
              const L = latest.current;
              const a = L.canvas.nodes.find((n) => n.id === from), b = L.canvas.nodes.find((n) => n.id === to);
              if (!a || !b) return;
              const [fromSide, toSide] = facing(a, b);
              const problem = connectProblem(L.canvas, from, to, fromSide, toSide);
              if (problem) { L.props.ctx.fail(problem); return; }
              const made = addEdge(L.canvas, from, to, fromSide, toSide);
              if (made) { commit(made.canvas); setSel({ nodes: [], edge: made.id }); }
            }} />
        </div>
      )}
      {missing > 0 && <div className="canvas-note muted small" data-canvas-ui>{missing} {missing === 1 ? "edge joins" : "edges join"} a card that is not on the board. {missing === 1 ? "It is" : "They are"} kept in the file and not drawn.</div>}
      {dialog === "file" && <FilePicker files={ctx.notebook?.files ?? []} onClose={() => setDialog(null)} onPick={(path) => { setDialog(null); addFile(path); }} />}
      {dialog === "note" && (
        <NoteCardDialog initial={null} onClose={() => setDialog(null)}
          onPick={(attrs) => { setDialog(null); add({ type: "link", url: `${MEM_PREFIX}${String(attrs.ref)}` }, "link"); }} />
      )}
    </div>
  );
}
