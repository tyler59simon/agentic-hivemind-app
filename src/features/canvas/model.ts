// A canvas board (NS-7C) in the JSON Canvas 1.0 format, as Obsidian writes it (`.canvas`). The model reads the file into
// plain objects and writes them back. Every field it does not know stays: unknown fields of a node or an edge, unknown
// top-level keys and nodes of a type it does not draw. Nothing here touches the disk or the document session.

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];
export type End = "none" | "arrow";
const ENDS: readonly string[] = ["none", "arrow"];

/** A card. Known fields are typed; everything else is kept as it was read. */
export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: string;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: End;
  toEnd?: End;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

/** `extra` holds the top-level keys other than `nodes` and `edges`, in the order they were read. */
export interface Canvas { nodes: CanvasNode[]; edges: CanvasEdge[]; extra: [string, unknown][] }

export type Parsed = { ok: true; canvas: Canvas } | { ok: false; reason: string };

export const emptyCanvas = (): Canvas => ({ nodes: [], edges: [], extra: [] });
/** What `New canvas` writes. */
export const NEW_CANVAS_TEXT = '{"nodes":[],"edges":[]}';

const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- Reading ----

/** What is wrong with a node, or null. Nodes of a type this code does not draw are only checked for what every node has. */
function nodeProblem(n: unknown, at: number): string | null {
  const where = `Node ${at + 1}`;
  if (!isObject(n)) return `${where} is not an object`;
  if (typeof n.id !== "string" || !n.id) return `${where} has no id`;
  if (typeof n.type !== "string" || !n.type) return `Node "${n.id}" has no type`;
  for (const key of ["x", "y", "width", "height"]) if (!finite(n[key])) return `Node "${n.id}" has no number for ${key}`;
  if (own(n, "color") && typeof n.color !== "string") return `Node "${n.id}" has a color that is not text`;
  const text = (key: string) => (own(n, key) && typeof n[key] !== "string" ? `Node "${n.id}" has a ${key} that is not text` : null);
  switch (n.type) {
    case "text": return text("text");
    case "file": return typeof n.file !== "string" || !n.file ? `File node "${n.id}" names no file` : text("subpath");
    case "link": return typeof n.url !== "string" ? `Link node "${n.id}" has no url` : null;
    case "group": return text("label") ?? text("background") ?? text("backgroundStyle");
    default: return null;
  }
}

/** What is wrong with an edge as a field list, or null. Whether its ends exist is a separate question (`dangling`). */
function edgeProblem(e: unknown, at: number): string | null {
  const where = `Edge ${at + 1}`;
  if (!isObject(e)) return `${where} is not an object`;
  if (typeof e.id !== "string" || !e.id) return `${where} has no id`;
  if (typeof e.fromNode !== "string" || !e.fromNode) return `Edge "${e.id}" has no fromNode`;
  if (typeof e.toNode !== "string" || !e.toNode) return `Edge "${e.id}" has no toNode`;
  for (const key of ["fromSide", "toSide"]) if (own(e, key) && !SIDES.includes(e[key] as Side)) return `Edge "${e.id}" has a ${key} that is not top, right, bottom or left`;
  for (const key of ["fromEnd", "toEnd"]) if (own(e, key) && !ENDS.includes(e[key] as string)) return `Edge "${e.id}" has a ${key} that is not none or arrow`;
  for (const key of ["color", "label"]) if (own(e, key) && typeof e[key] !== "string") return `Edge "${e.id}" has a ${key} that is not text`;
  return null;
}

/** Read a `.canvas` file. A blank file is an empty board (Obsidian treats it so). Anything the board cannot hold without
 *  losing data is refused with the reason, so the file opens as source instead and nothing is written. An edge that names a
 *  node that is not there is kept and not drawn. */
export function parseCanvas(text: string): Parsed {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!source.trim()) return { ok: true, canvas: emptyCanvas() };
  let value: unknown;
  try { value = JSON.parse(source); } catch (e) { return { ok: false, reason: `It is not valid JSON (${e instanceof Error ? e.message : String(e)})` }; }
  if (!isObject(value)) return { ok: false, reason: "It is not a JSON Canvas: the top level is not an object" };
  const nodes = own(value, "nodes") ? value.nodes : [];
  const edges = own(value, "edges") ? value.edges : [];
  if (!Array.isArray(nodes)) return { ok: false, reason: "Its nodes are not a list" };
  if (!Array.isArray(edges)) return { ok: false, reason: "Its edges are not a list" };
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const problem = nodeProblem(nodes[i], i);
    if (problem) return { ok: false, reason: problem };
    const id = (nodes[i] as CanvasNode).id;
    if (ids.has(id)) return { ok: false, reason: `Two nodes have the id "${id}"` };
    ids.add(id);
  }
  const edgeIds = new Set<string>();
  for (let i = 0; i < edges.length; i++) {
    const problem = edgeProblem(edges[i], i);
    if (problem) return { ok: false, reason: problem };
    const id = (edges[i] as CanvasEdge).id;
    if (edgeIds.has(id)) return { ok: false, reason: `Two edges have the id "${id}"` };
    edgeIds.add(id);
  }
  const extra = Object.keys(value).filter((k) => k !== "nodes" && k !== "edges").map((k): [string, unknown] => [k, value[k]]);
  return { ok: true, canvas: { nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[], extra } };
}

/** Why a file cannot be shown as a board, or null when it can. */
export function canvasProblem(text: string): string | null {
  const parsed = parseCanvas(text);
  return parsed.ok ? null : parsed.reason;
}

/** The edges that name a node the canvas does not have. They stay in the file and are not drawn. */
export const dangling = (c: Canvas) => {
  const ids = new Set(c.nodes.map((n) => n.id));
  return c.edges.filter((e) => !ids.has(e.fromNode) || !ids.has(e.toNode));
};

// ---- Writing ----

// One fixed order for the known keys, then the unknown ones as they were read. Obsidian writes `id`, `type`, the content,
// then the box; its own order may differ between versions, so the first save of a file can reorder keys.
const NODE_KEYS = ["id", "type", "text", "file", "subpath", "url", "label", "background", "backgroundStyle", "x", "y", "width", "height", "color"];
const EDGE_KEYS = ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"];

function line(obj: Record<string, unknown>, order: readonly string[]): string {
  const keys = [...order.filter((k) => own(obj, k)), ...Object.keys(obj).filter((k) => !order.includes(k))].filter((k) => obj[k] !== undefined);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(",")}}`;
}

/** The file's text: tab indented, one node or edge per line as Obsidian writes it, keys in a fixed order, no trailing
 *  newline. Writing what was just read gives the same text again. */
export function writeCanvas(c: Canvas): string {
  const list = (items: string[]) => (items.length ? `[\n${items.map((i) => `\t\t${i}`).join(",\n")}\n\t]` : "[]");
  const parts = [
    `\t"nodes":${list(c.nodes.map((n) => line(n, NODE_KEYS)))}`,
    `\t"edges":${list(c.edges.map((e) => line(e, EDGE_KEYS)))}`,
    ...c.extra.map(([k, v]) => `\t${JSON.stringify(k)}:${JSON.stringify(v)}`),
  ];
  return `{\n${parts.join(",\n")}\n}`;
}

/** `next` with every card and edge that is the same as one in `prev` replaced by that very object, so a board drawn from the
 *  new text draws again only what changed. When nothing changed the lists are `prev`'s own. */
export function reuse(prev: Canvas, next: Canvas): Canvas {
  const same = <T extends { id: string }>(old: T[], now: T[], order: readonly string[]): T[] => {
    const byId = new Map(old.map((o) => [o.id, o]));
    const out = now.map((n) => {
      const o = byId.get(n.id);
      return o && line(o, order) === line(n, order) ? o : n;
    });
    return out.length === old.length && out.every((o, i) => o === old[i]) ? old : out;
  };
  return { nodes: same(prev.nodes, next.nodes, NODE_KEYS), edges: same(prev.edges, next.edges, EDGE_KEYS), extra: next.extra };
}

// ---- Colours ----

/** The JSON Canvas presets, drawn with the rich page palette (App.css `--pal-*`). The spec's `"5"` is cyan; the palette has
 *  no cyan, so it is drawn blue. */
export const PRESETS: Record<string, string> = { "1": "red", "2": "orange", "3": "yellow", "4": "green", "5": "blue", "6": "purple" };
export type Colour = { kind: "preset"; name: string } | { kind: "hex"; value: string };
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A card's or edge's colour: a preset name, a hex colour, or null for none or anything else (which is kept in the file). */
export function colourOf(color: unknown): Colour | null {
  if (typeof color !== "string") return null;
  if (own(PRESETS, color)) return { kind: "preset", name: PRESETS[color] };
  return HEX.test(color) ? { kind: "hex", value: color } : null;
}

// ---- Geometry ----

export const MIN_W = 60;
export const MIN_H = 40;
export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function anchor(n: Box, side: Side): Point {
  switch (side) {
    case "top": return { x: n.x + n.width / 2, y: n.y };
    case "bottom": return { x: n.x + n.width / 2, y: n.y + n.height };
    case "left": return { x: n.x, y: n.y + n.height / 2 };
    case "right": return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

const NORMAL: Record<Side, Point> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/** The sides of `a` and `b` that face each other. */
export function facing(a: Box, b: Box): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2), dy = b.y + b.height / 2 - (a.y + a.height / 2);
  const from: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
  return [from, opposite[from]];
}

/** The side of `box` nearest to the point `p`. */
export function nearestSide(box: Box, p: Point): Side {
  return SIDES.reduce((best, s) => {
    const a = anchor(box, s), b = anchor(box, best);
    return Math.hypot(a.x - p.x, a.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? s : best;
  }, "top" as Side);
}

export interface EdgeShape { d: string; mid: Point; from: { tip: Point; dir: Point }; to: { tip: Point; dir: Point } }

/** The curve between two sides, its middle (for the label) and the tip and direction of each end's arrowhead. */
export function edgeShape(a: Box, b: Box, fromSide: Side, toSide: Side): EdgeShape {
  const p1 = anchor(a, fromSide), p2 = anchor(b, toSide);
  const pull = Math.max(40, Math.min(200, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2));
  const c1 = { x: p1.x + NORMAL[fromSide].x * pull, y: p1.y + NORMAL[fromSide].y * pull };
  const c2 = { x: p2.x + NORMAL[toSide].x * pull, y: p2.y + NORMAL[toSide].y * pull };
  return {
    d: `M${p1.x} ${p1.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`,
    mid: { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 },
    // The arrow points into the card: against the side's outward normal.
    from: { tip: p1, dir: { x: -NORMAL[fromSide].x, y: -NORMAL[fromSide].y } },
    to: { tip: p2, dir: { x: -NORMAL[toSide].x, y: -NORMAL[toSide].y } },
  };
}

/** A triangle with its tip at `tip`, pointing along `dir`. */
export function arrowPath(tip: Point, dir: Point, size = 12): string {
  const bx = tip.x - dir.x * size, by = tip.y - dir.y * size, px = -dir.y * size * 0.4, py = dir.x * size * 0.4;
  return `M${tip.x} ${tip.y}L${bx + px} ${by + py}L${bx - px} ${by - py}Z`;
}

export interface View { x: number; y: number; k: number }
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The view that shows every card with a margin inside a pane of `w` by `h`. */
export function fitView(nodes: Box[], w: number, h: number, margin = 48): View {
  if (!nodes.length || w <= 0 || h <= 0) return { x: 0, y: 0, k: 1 };
  const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
  const x1 = Math.max(...nodes.map((n) => n.x + n.width)), y1 = Math.max(...nodes.map((n) => n.y + n.height));
  const k = clampZoom(Math.min((w - margin * 2) / Math.max(1, x1 - x0), (h - margin * 2) / Math.max(1, y1 - y0), 1.5));
  return { k, x: (w - (x1 - x0) * k) / 2 - x0 * k, y: (h - (y1 - y0) * k) / 2 - y0 * k };
}

/** Zoom to `k` keeping the canvas point under (`px`, `py`) of the pane where it is. */
export function zoomAt(v: View, k: number, px: number, py: number): View {
  const next = clampZoom(k);
  return { k: next, x: px - ((px - v.x) * next) / v.k, y: py - ((py - v.y) * next) / v.k };
}

// ---- Changes: each returns a new canvas and leaves the cards it does not change as the same objects ----

/** A new id as Obsidian makes them: 16 lower case hex digits. */
export function newId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = new Uint8Array(8);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}

export const SIZES: Record<string, { width: number; height: number }> = {
  text: { width: 260, height: 120 }, file: { width: 280, height: 160 }, picture: { width: 320, height: 240 }, link: { width: 280, height: 110 }, group: { width: 420, height: 300 },
};

/** The content of a card to add; the box is given with it. */
export interface NewNode { type: string; text?: string; file?: string; url?: string; label?: string; [key: string]: unknown }

/** Add a card. A group goes first so it is drawn behind the cards. */
export function addNode(c: Canvas, node: NewNode & Box): { canvas: Canvas; id: string } {
  const id = newId(new Set(c.nodes.map((n) => n.id)));
  const added = { id, ...node } as CanvasNode;
  return { id, canvas: { ...c, nodes: node.type === "group" ? [added, ...c.nodes] : [...c.nodes, added] } };
}

/** Change fields of one card; a field set to undefined is removed. */
export function setNode(c: Canvas, id: string, patch: Partial<CanvasNode>): Canvas {
  return { ...c, nodes: c.nodes.map((n) => (n.id === id ? withPatch(n, patch) : n)) };
}
export function setEdge(c: Canvas, id: string, patch: Partial<CanvasEdge>): Canvas {
  return { ...c, edges: c.edges.map((e) => (e.id === id ? withPatch(e, patch) : e)) };
}
function withPatch<T extends Record<string, unknown>>(o: T, patch: Partial<T>): T {
  const next: Record<string, unknown> = { ...o, ...patch };
  for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
  return next as T;
}

export function moveNodes(c: Canvas, ids: ReadonlySet<string>, dx: number, dy: number): Canvas {
  return { ...c, nodes: c.nodes.map((n) => (ids.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) };
}

/** The box `b` after dragging its corner (`nw`, `ne`, `sw` or `se`) by (`dx`, `dy`); the opposite corner stays put. */
export function resizedBox(b: Box, corner: string, dx: number, dy: number): Box {
  let { x, y, width, height } = b;
  if (corner.includes("e")) width = Math.max(MIN_W, b.width + dx);
  if (corner.includes("s")) height = Math.max(MIN_H, b.height + dy);
  if (corner.includes("w")) { width = Math.max(MIN_W, b.width - dx); x = b.x + b.width - width; }
  if (corner.includes("n")) { height = Math.max(MIN_H, b.height - dy); y = b.y + b.height - height; }
  return { x, y, width, height };
}

export function resizeNode(c: Canvas, id: string, box: Box): Canvas {
  const round = (v: number) => Math.round(v);
  return setNode(c, id, { x: round(box.x), y: round(box.y), width: Math.max(MIN_W, round(box.width)), height: Math.max(MIN_H, round(box.height)) });
}

/** Cards from top to bottom, then left to right: the order the keyboard walks them in. */
export function readingOrder(nodes: readonly CanvasNode[]): CanvasNode[] {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `ids` and, for each group among them, the cards inside it: what a move takes along. */
export function withInside(c: Canvas, ids: Iterable<string>): Set<string> {
  const all = new Set(ids);
  for (const id of [...all]) for (const inner of inside(c, id)) all.add(inner);
  return all;
}

/** The ids of the cards that lie wholly inside a group, so moving the group takes them along. */
export function inside(c: Canvas, groupId: string): string[] {
  const g = c.nodes.find((n) => n.id === groupId);
  if (!g || g.type !== "group") return [];
  return c.nodes.filter((n) => n.id !== groupId && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height).map((n) => n.id);
}

/** Remove cards and edges; the edges of a removed card go with it. */
export function removeItems(c: Canvas, nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): Canvas {
  return {
    ...c,
    nodes: c.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: c.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)),
  };
}

/** Why an edge cannot join these two cards, or null. */
export function connectProblem(c: Canvas, from: string, to: string, fromSide: Side, toSide: Side): string | null {
  if (from === to) return "A card cannot be joined to itself";
  if (!c.nodes.some((n) => n.id === from) || !c.nodes.some((n) => n.id === to)) return "Both ends of an edge must be cards on the board";
  if (c.edges.some((e) => e.fromNode === from && e.toNode === to && (e.fromSide ?? null) === fromSide && (e.toSide ?? null) === toSide)) return "Those two sides are already joined";
  return null;
}

/** Join two cards by their sides. Null when the edge is not valid (`connectProblem`). */
export function addEdge(c: Canvas, from: string, to: string, fromSide: Side, toSide: Side): { canvas: Canvas; id: string } | null {
  if (connectProblem(c, from, to, fromSide, toSide)) return null;
  const id = newId(new Set(c.edges.map((e) => e.id)));
  return { id, canvas: { ...c, edges: [...c.edges, { id, fromNode: from, fromSide, toNode: to, toSide }] } };
}
