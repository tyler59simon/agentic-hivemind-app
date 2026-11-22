// NS-7C: the JSON Canvas model. A canvas Obsidian wrote reads and writes without losing any field, keys are written in a fixed
// order, a file the board cannot hold is refused with a reason, edges are checked, and colours map to the palette.
import { describe, expect, it } from "vitest";
import {
  addEdge, addNode, canvasProblem, colourOf, connectProblem, dangling, emptyCanvas, fitView, inside, moveNodes, NEW_CANVAS_TEXT, parseCanvas, removeItems, resizedBox,
  setNode, writeCanvas, zoomAt, type Canvas,
} from "./model";

/** What Obsidian writes: tabs, one card per line, and fields this code does not know. */
const OBSIDIAN = `{
\t"nodes":[
\t\t{"id":"g1","type":"group","label":"Ideas","x":-400,"y":-300,"width":800,"height":600,"color":"3","background":"bg.png","backgroundStyle":"cover","vault":{"pinned":true}},
\t\t{"id":"t1","type":"text","text":"# Hello\\nworld","x":-300,"y":-200,"width":250,"height":120,"color":"#ff8800","future":[1,2,{"a":null}]},
\t\t{"id":"f1","type":"file","file":"Plan.md","subpath":"#Goals","x":0,"y":-200,"width":300,"height":200},
\t\t{"id":"l1","type":"link","url":"https://example.com/a?b=c","x":0,"y":100,"width":260,"height":100},
\t\t{"id":"w1","type":"widget","kind":"chart","x":300,"y":100,"width":100,"height":100}
\t],
\t"edges":[
\t\t{"id":"e1","fromNode":"t1","fromSide":"right","toNode":"f1","toSide":"left","toEnd":"none","color":"4","label":"relates","weight":3},
\t\t{"id":"e2","fromNode":"l1","fromSide":"top","fromEnd":"arrow","toNode":"f1","toSide":"bottom"}
\t],
\t"metadata":{"version":"1.0-1.0","frontmatter":{}},
\t"extension":[true]
}`;

const read = (text: string): Canvas => {
  const parsed = parseCanvas(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.canvas;
};

describe("reading and writing", () => {
  it("keeps every field of every node and edge, and the unknown top-level keys, through a write and a read", () => {
    const first = read(OBSIDIAN);
    const second = read(writeCanvas(first));
    expect(second).toEqual(first);
    // The unknown pieces are really there, not just equal because both lost them.
    expect(second.nodes[0]).toMatchObject({ background: "bg.png", backgroundStyle: "cover", vault: { pinned: true } });
    expect(second.nodes[1].future).toEqual([1, 2, { a: null }]);
    expect(second.nodes[4]).toMatchObject({ type: "widget", kind: "chart" });
    expect(second.edges[0]).toMatchObject({ weight: 3, toEnd: "none" });
    expect(second.extra).toEqual([["metadata", { version: "1.0-1.0", frontmatter: {} }], ["extension", [true]]]);
  });

  it("writes the same text for what it just read, so a second save changes nothing", () => {
    const once = writeCanvas(read(OBSIDIAN));
    expect(writeCanvas(read(once))).toBe(once);
  });

  it("writes keys in one fixed order whatever order they were read in", () => {
    const shuffled = '{"edges":[{"label":"x","toNode":"b","color":"2","fromNode":"a","id":"e"}],"zzz":1,"nodes":[{"height":5,"text":"hi","width":6,"y":2,"type":"text","x":1,"id":"a","mine":"kept","color":"1"},{"id":"b","type":"text","text":"","x":0,"y":0,"width":9,"height":9}],"aaa":2}';
    expect(writeCanvas(read(shuffled))).toBe([
      "{",
      '\t"nodes":[',
      '\t\t{"id":"a","type":"text","text":"hi","x":1,"y":2,"width":6,"height":5,"color":"1","mine":"kept"},',
      '\t\t{"id":"b","type":"text","text":"","x":0,"y":0,"width":9,"height":9}',
      "\t],",
      '\t"edges":[',
      '\t\t{"id":"e","fromNode":"a","toNode":"b","color":"2","label":"x"}',
      "\t],",
      '\t"zzz":1,',
      '\t"aaa":2',
      "}",
    ].join("\n"));
  });

  it("reads the new canvas text and a blank file as an empty board, and writes an empty board as the two empty lists", () => {
    expect(read(NEW_CANVAS_TEXT)).toEqual(emptyCanvas());
    expect(read("  \n")).toEqual(emptyCanvas());
    expect(writeCanvas(emptyCanvas())).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
    // The lists are optional in the format.
    expect(read("{}")).toEqual(emptyCanvas());
  });

  it("does not trip over a key called __proto__ in a node or at the top level", () => {
    const text = '{"nodes":[{"id":"a","type":"text","text":"","x":0,"y":0,"width":1,"height":1,"__proto__":{"x":1}}],"edges":[],"__proto__":2}';
    const out = writeCanvas(read(text));
    expect(out).toContain('"__proto__":{"x":1}');
    expect(out).toContain('"__proto__":2');
    expect(({} as { x?: number }).x).toBeUndefined();
  });
});

describe("a file the board cannot hold is refused with a reason", () => {
  const node = (extra: object = {}) => ({ id: "a", type: "text", text: "", x: 0, y: 0, width: 10, height: 10, ...extra });
  const edge = (extra: object = {}) => ({ id: "e", fromNode: "a", toNode: "b", ...extra });
  const file = (nodes: unknown[], edges: unknown[] = []) => JSON.stringify({ nodes, edges });
  const b = node({ id: "b" });

  it.each([
    ["invalid JSON", "{nodes:", /not valid JSON/],
    ["a top level that is a list", "[1,2]", /top level is not an object/],
    ["nodes that are not a list", '{"nodes":{}}', /nodes are not a list/],
    ["edges that are not a list", '{"edges":"x"}', /edges are not a list/],
    ["a node that is not an object", file([3]), /Node 1 is not an object/],
    ["a node with no id", file([{ ...node(), id: undefined }]), /Node 1 has no id/],
    ["a node with no type", file([{ ...node(), type: "" }]), /has no type/],
    ["a node with a missing coordinate", file([{ ...node(), width: undefined }]), /no number for width/],
    ["a node with a coordinate that is text", file([node({ x: "0" })]), /no number for x/],
    ["a node whose color is not text", file([node({ color: 3 })]), /color that is not text/],
    ["a text node whose text is not text", file([node({ text: 5 })]), /text that is not text/],
    ["a file node with no file", file([node({ type: "file", file: "" })]), /names no file/],
    ["a link node with no url", file([node({ type: "link", text: undefined })]), /has no url/],
    ["two nodes with one id", file([node(), node()]), /Two nodes have the id "a"/],
    ["an edge with no id", file([node(), b], [{ ...edge(), id: undefined }]), /Edge 1 has no id/],
    ["an edge with no end", file([node(), b], [edge({ toNode: "" })]), /no toNode/],
    ["an edge side that is not a side", file([node(), b], [edge({ fromSide: "middle" })]), /fromSide that is not top, right, bottom or left/],
    ["an edge end that is not an end", file([node(), b], [edge({ toEnd: "dot" })]), /toEnd that is not none or arrow/],
    ["an edge label that is not text", file([node(), b], [edge({ label: 1 })]), /label that is not text/],
    ["two edges with one id", file([node(), b], [edge(), edge()]), /Two edges have the id "e"/],
  ])("%s", (_name, text, reason) => {
    const parsed = parseCanvas(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toMatch(reason);
    expect(canvasProblem(text)).toMatch(reason);
  });

  it("holds a node of a type it does not draw, and an edge to a card that is not there, without refusing", () => {
    const text = file([node(), node({ id: "z", type: "widget", text: undefined })], [edge({ toNode: "ghost" })]);
    const canvas = read(text);
    expect(canvasProblem(text)).toBeNull();
    expect(dangling(canvas).map((e) => e.id)).toEqual(["e"]);
    // Kept in the file, so saving other changes does not lose it.
    expect(read(writeCanvas(canvas)).edges).toHaveLength(1);
  });
});

describe("edges", () => {
  const two = () => read(JSON.stringify({ nodes: [
    { id: "a", type: "text", text: "", x: 0, y: 0, width: 100, height: 50 },
    { id: "b", type: "text", text: "", x: 300, y: 0, width: 100, height: 50 },
  ], edges: [] }));

  it("joins two cards by their sides and writes both sides", () => {
    const made = addEdge(two(), "a", "b", "right", "left");
    expect(made).not.toBeNull();
    expect(made!.canvas.edges).toEqual([{ id: made!.id, fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" }]);
    expect(made!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(writeCanvas(made!.canvas)).toContain(`{"id":"${made!.id}","fromNode":"a","fromSide":"right","toNode":"b","toSide":"left"}`);
  });

  it("refuses an edge to itself, to a card that is not there, and the same join twice", () => {
    const c = two();
    expect(connectProblem(c, "a", "a", "right", "left")).toMatch(/itself/);
    expect(addEdge(c, "a", "a", "right", "left")).toBeNull();
    expect(connectProblem(c, "a", "nope", "right", "left")).toMatch(/Both ends/);
    expect(addEdge(c, "nope", "b", "right", "left")).toBeNull();
    const once = addEdge(c, "a", "b", "right", "left")!.canvas;
    expect(addEdge(once, "a", "b", "right", "left")).toBeNull();
    // Another pair of sides is another edge.
    expect(addEdge(once, "a", "b", "bottom", "top")).not.toBeNull();
  });

  it("removes the edges of a card when the card goes", () => {
    const c = addEdge(two(), "a", "b", "right", "left")!.canvas;
    const out = removeItems(c, new Set(["b"]), new Set());
    expect(out.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(out.edges).toEqual([]);
  });
});

describe("colours", () => {
  it("maps the six presets to the palette names, with cyan drawn as blue", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((n) => colourOf(n))).toEqual([
      { kind: "preset", name: "red" }, { kind: "preset", name: "orange" }, { kind: "preset", name: "yellow" },
      { kind: "preset", name: "green" }, { kind: "preset", name: "blue" }, { kind: "preset", name: "purple" },
    ]);
  });

  it("takes hex colours, and nothing else that could reach a style", () => {
    expect(colourOf("#ff8800")).toEqual({ kind: "hex", value: "#ff8800" });
    expect(colourOf("#f80")).toEqual({ kind: "hex", value: "#f80" });
    expect(colourOf("#ff880080")).toEqual({ kind: "hex", value: "#ff880080" });
    for (const bad of ["7", "0", "red", "#12", "#ggg", "#ff8800; background: url(x)", "url(x)", "", 3, null, undefined]) expect(colourOf(bad)).toBeNull();
  });
});

describe("changes", () => {
  const board = () => read(JSON.stringify({ nodes: [
    { id: "g", type: "group", label: "G", x: 0, y: 0, width: 400, height: 300 },
    { id: "a", type: "text", text: "", x: 10, y: 10, width: 100, height: 50 },
    { id: "b", type: "text", text: "", x: 500, y: 10, width: 100, height: 50 },
  ], edges: [] }));

  it("moves only the cards asked, and leaves the others as the same objects", () => {
    const c = board();
    const moved = moveNodes(c, new Set(["a"]), 5.4, -2.6);
    expect(moved.nodes[1]).toMatchObject({ x: 15, y: 7 });
    expect(moved.nodes[0]).toBe(c.nodes[0]);
    expect(moved.nodes[2]).toBe(c.nodes[2]);
  });

  it("knows which cards lie inside a group", () => {
    expect(inside(board(), "g")).toEqual(["a"]);
    expect(inside(board(), "a")).toEqual([]);
  });

  it("sets and removes fields of a card, keeping the ones it does not touch", () => {
    const c = setNode(board(), "g", { label: undefined, color: "2" });
    expect(c.nodes[0]).toEqual({ id: "g", type: "group", x: 0, y: 0, width: 400, height: 300, color: "2" });
  });

  it("puts a new group first so it is drawn behind, and other cards last", () => {
    const box = { x: 0, y: 0, width: 5, height: 5 };
    expect(addNode(board(), { type: "group", ...box }).canvas.nodes[0].type).toBe("group");
    const text = addNode(board(), { type: "text", text: "", ...box });
    expect(text.canvas.nodes[text.canvas.nodes.length - 1].id).toBe(text.id);
  });

  it("keeps a corner drag from making a card smaller than the minimum", () => {
    const b = { x: 0, y: 0, width: 200, height: 100 };
    expect(resizedBox(b, "se", 50, 20)).toEqual({ x: 0, y: 0, width: 250, height: 120 });
    expect(resizedBox(b, "nw", 500, 500)).toEqual({ x: 140, y: 60, width: 60, height: 40 });
  });

  it("zooms about a point so the point stays where it is, and fits every card", () => {
    const v = zoomAt({ x: 10, y: 20, k: 1 }, 2, 100, 100);
    expect(v).toEqual({ k: 2, x: -80, y: -60 });
    expect((100 - v.x) / v.k).toBe((100 - 10) / 1);
    const fit = fitView([{ x: 0, y: 0, width: 400, height: 200 }], 800, 600);
    expect(fit.k).toBeGreaterThan(1);
    expect(fit.x + 200 * fit.k).toBeCloseTo(400);
    expect(fitView([], 800, 600)).toEqual({ x: 0, y: 0, k: 1 });
  });
});
