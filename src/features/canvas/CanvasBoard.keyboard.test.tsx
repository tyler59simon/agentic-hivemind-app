// @vitest-environment jsdom
// DESK-A11Y A3: the board without a pointer. One card is the Tab stop and the arrow keys walk the cards in reading order; every
// card has a name; Enter, F2 and Escape edit and leave an edit; Ctrl+Arrow and Ctrl+Shift+Arrow move and resize through the same
// commit as a drag (WCAG 2.5.7); a Connections list names the edges and a form joins two cards; axe finds nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../notes/PageView", () => ({ PageView: (p: { text: string }) => <div className="markdown">{p.text}</div> }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../lib/lm", async (orig) => ({
  ...(await orig<typeof import("../../lib/lm")>()),
  read: vi.fn(async () => ({ title: "Use SQLite", type: "decision", status: "active", body: "# Heading\nWe keep one file." })),
}));

const { default: CanvasEditor } = await import("./CanvasEditor");
const { parseCanvas, writeCanvas } = await import("./model");
const { openUrl } = await import("@tauri-apps/plugin-opener");

const GRANT = "http://hmfile.localhost/g1/";
const read = (text: string) => { const p = parseCanvas(text); if (!p.ok) throw new Error(p.reason); return p.canvas; };
const file = (nodes: unknown[], edges: unknown[] = []) => writeCanvas(read(JSON.stringify({ nodes, edges })));
const text = (id: string, x: number, y: number, extra: object = {}) => ({ id, type: "text", text: `card ${id}`, x, y, width: 100, height: 50, ...extra });

const ctx = {
  pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
  notebook: { files: ["Plan.md"], url: (p: string) => `${GRANT}${p}`, read: vi.fn(), create: vi.fn(), save: vi.fn(), trash: vi.fn() },
};
const PICTURES = { base: GRANT, folder: "", files: [] };
let root: Root | null = null;
const changes: string[] = [];
const opened: string[] = [];

function Harness({ initial, readOnly = false }: { initial: string; readOnly?: boolean }) {
  const [doc, setDoc] = useState(initial);
  return <CanvasEditor text={doc} readOnly={readOnly} ctx={ctx as never} pictures={PICTURES} notebook="nb-1" onOpenFile={(p) => { opened.push(p); }}
    onChange={(t) => { changes.push(t); setDoc(t); }} />;
}
async function mount(initial: string, readOnly = false) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Harness initial={initial} readOnly={readOnly} />); });
  return el;
}
const card = (el: ParentNode, id: string) => el.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
const key = (target: Element, k: string, mods: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
const focus = (target: HTMLElement) => act(async () => { target.focus(); });
const last = () => read(changes[changes.length - 1]);
const active = () => (document.activeElement as HTMLElement | null)?.dataset.nodeId ?? document.activeElement?.className;
const button = (el: ParentNode, name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

beforeEach(() => { changes.length = 0; opened.length = 0; ctx.fail.mockClear(); vi.mocked(openUrl).mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

// Reading order is top to bottom, then left to right: a (0,0), b (200,0), c (0,100), d (200,100).
const four = () => file([text("d", 200, 100), text("b", 200, 0), text("c", 0, 100), text("a", 0, 0)]);

describe("the Tab stop and the names", () => {
  it("has one card with tabindex 0, the first in reading order, and the board and the other cards at -1", async () => {
    const el = await mount(four());
    const stops = [...el.querySelectorAll<HTMLElement>("[data-node-id]")].filter((n) => n.tabIndex === 0).map((n) => n.dataset.nodeId);
    expect(stops).toEqual(["a"]);
    expect(el.querySelector<HTMLElement>(".canvas-board")!.tabIndex).toBe(-1);
  });

  it("leaves the board itself as the Tab stop when it has no cards", async () => {
    const el = await mount(file([]));
    expect(el.querySelector<HTMLElement>(".canvas-board")!.tabIndex).toBe(0);
  });

  it("names each card by its kind and what it holds", async () => {
    const el = await mount(file([
      text("t", 0, 0, { text: "# Plan the year\nmore" }), text("e", 0, 60, { text: "" }),
      { id: "f", type: "file", file: "Notes/Plan.md", x: 200, y: 0, width: 100, height: 50 },
      { id: "l", type: "link", url: "https://example.com/a", x: 200, y: 60, width: 100, height: 50 },
      { id: "m", type: "link", url: "hivemind:mem:d:abc", x: 200, y: 120, width: 100, height: 50 },
      { id: "g", type: "group", label: "Ideas", x: 400, y: 0, width: 100, height: 50 },
    ]));
    const names = Object.fromEntries([...el.querySelectorAll("[data-node-id]")].map((n) => [(n as HTMLElement).dataset.nodeId, n.getAttribute("aria-label")]));
    expect(names).toEqual({
      t: "Text card: Plan the year", e: "Text card: empty", f: "File: Plan.md", l: "Link: https://example.com/a", m: "Memory note: d:abc", g: "Group: Ideas",
    });
    expect([...el.querySelectorAll("[data-node-id]")].every((n) => n.getAttribute("role") === "group")).toBe(true);
  });
});

describe("walking the cards", () => {
  it("moves focus and selection in reading order with the arrow keys, and to the ends with Home and End", async () => {
    const el = await mount(four());
    await focus(card(el, "a"));
    expect(card(el, "a").classList.contains("on")).toBe(true);
    await key(card(el, "a"), "ArrowRight");
    expect(active()).toBe("b");
    await key(card(el, "b"), "ArrowDown");
    expect(active()).toBe("c");
    expect(card(el, "c").classList.contains("on")).toBe(true);
    expect(card(el, "b").classList.contains("on")).toBe(false);
    await key(card(el, "c"), "ArrowUp");
    expect(active()).toBe("b");
    await key(card(el, "b"), "End");
    expect(active()).toBe("d");
    await key(card(el, "d"), "ArrowRight");
    expect(active()).toBe("d");
    await key(card(el, "d"), "Home");
    expect(active()).toBe("a");
    await key(card(el, "a"), "ArrowLeft");
    expect(active()).toBe("a");
    expect(changes).toHaveLength(0);
  });

  it("makes the card it reached the Tab stop", async () => {
    const el = await mount(four());
    await focus(card(el, "a"));
    await key(card(el, "a"), "End");
    expect([...el.querySelectorAll<HTMLElement>("[data-node-id]")].filter((n) => n.tabIndex === 0).map((n) => n.dataset.nodeId)).toEqual(["d"]);
  });
});

describe("editing and deleting", () => {
  it("Enter and F2 start editing a text card; Escape gives the edit up and puts focus back on the card", async () => {
    const el = await mount(four());
    await focus(card(el, "b"));
    await key(card(el, "b"), "Enter");
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(area);
    area.value = "dropped";
    await key(area, "Escape");
    expect(el.querySelector("textarea")).toBeNull();
    expect(active()).toBe("b");
    expect(changes).toHaveLength(0);
    await key(card(el, "b"), "F2");
    expect(el.querySelector("textarea")).not.toBeNull();
  });

  it("Ctrl+Enter writes the edit and puts focus back on the card", async () => {
    const el = await mount(four());
    await focus(card(el, "b"));
    await key(card(el, "b"), "Enter");
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    area.value = "typed";
    await key(area, "Enter", { ctrlKey: true });
    expect(last().nodes.find((n) => n.id === "b")!.text).toBe("typed");
    expect(active()).toBe("b");
  });

  it("Enter opens a file card's file as a double-click does, and on a button inside a card does not start an edit", async () => {
    const el = await mount(file([
      { id: "f", type: "file", file: "Plan.md", x: 0, y: 0, width: 100, height: 50 },
      { id: "l", type: "link", url: "https://example.com", x: 200, y: 0, width: 160, height: 80 },
    ]));
    await focus(card(el, "f"));
    await key(card(el, "f"), "Enter");
    expect(opened).toEqual(["Plan.md"]);
    await focus(card(el, "l"));
    await key(el.querySelector(".canvas-open")!, "Enter");
    expect(el.querySelector("input")).toBeNull();
  });

  it("Delete removes the card in one change and puts focus on the next card; Ctrl+Z brings it back", async () => {
    const el = await mount(four());
    const start = four();
    await focus(card(el, "b"));
    await key(card(el, "b"), "Delete");
    expect(last().nodes.map((n) => n.id).sort()).toEqual(["a", "c", "d"]);
    expect(active()).toBe("c");
    await key(card(el, "c"), "z", { ctrlKey: true });
    expect(changes[changes.length - 1]).toBe(start);
  });

  it("Delete on the last card puts focus on the one before it, and on the only card on the board", async () => {
    const el = await mount(file([text("a", 0, 0), text("b", 200, 0)]));
    await focus(card(el, "b"));
    await key(card(el, "b"), "Delete");
    expect(active()).toBe("a");
    await key(card(el, "a"), "Delete");
    expect(active()).toBe("canvas-board");
  });
});

describe("moving and resizing without a drag", () => {
  it("Ctrl+Arrow moves the card by 8 in one change, the same change a drag makes", async () => {
    const el = await mount(four());
    await focus(card(el, "b"));
    await key(card(el, "b"), "ArrowRight", { ctrlKey: true });
    expect(changes).toHaveLength(1);
    expect(last().nodes.find((n) => n.id === "b")).toMatchObject({ x: 208, y: 0, width: 100, height: 50 });
    await key(card(el, "b"), "ArrowUp", { metaKey: true });
    expect(last().nodes.find((n) => n.id === "b")).toMatchObject({ x: 208, y: -8 });
    expect(last().nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
  });

  it("takes the cards inside a group along, as a drag does", async () => {
    const el = await mount(file([
      text("g", 0, 0, { type: "group", text: undefined, label: "G", width: 400, height: 300 }), text("in", 20, 40), text("out", 600, 0),
    ]));
    await focus(card(el, "g"));
    await key(card(el, "g"), "ArrowDown", { ctrlKey: true });
    expect(last().nodes.map((n) => [n.id, n.y])).toEqual([["g", 8], ["in", 48], ["out", 0]]);
  });

  it("Ctrl+Shift+Arrow resizes by 8 from the bottom right corner, and never below the smallest size", async () => {
    const el = await mount(file([text("a", 0, 0)]));
    await focus(card(el, "a"));
    await key(card(el, "a"), "ArrowRight", { ctrlKey: true, shiftKey: true });
    await key(card(el, "a"), "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(last().nodes[0]).toMatchObject({ x: 0, y: 0, width: 108, height: 58 });
    for (let i = 0; i < 20; i++) await key(card(el, "a"), "ArrowLeft", { ctrlKey: true, shiftKey: true });
    expect(last().nodes[0]).toMatchObject({ width: 60 });
  });

  it("a run of presses is one step of undo, and Ctrl+Z puts the card back where it began", async () => {
    const start = file([text("a", 0, 0)]);
    const el = await mount(start);
    await focus(card(el, "a"));
    for (let i = 0; i < 5; i++) await key(card(el, "a"), "ArrowRight", { ctrlKey: true });
    expect(last().nodes[0].x).toBe(40);
    await key(card(el, "a"), "z", { ctrlKey: true });
    expect(changes[changes.length - 1]).toBe(start);
  });

  it("does nothing on a read-only board, and Alt+Arrow is left to the app (Alt+Left is Back)", async () => {
    const el = await mount(four(), true);
    await focus(card(el, "a"));
    await key(card(el, "a"), "ArrowRight", { ctrlKey: true });
    await key(card(el, "a"), "ArrowRight", { ctrlKey: true, shiftKey: true });
    expect(changes).toHaveLength(0);
    const writable = document.createElement("div");
    document.body.append(writable);
    await act(async () => root!.unmount());
    root = createRoot(writable);
    await act(async () => { root!.render(<Harness initial={four()} />); });
    await focus(card(writable, "a"));
    await key(card(writable, "a"), "ArrowLeft", { altKey: true });
    expect(changes).toHaveLength(0);
  });
});

describe("connections", () => {
  const withEdges = () => file(
    [text("a", 0, 0), text("b", 300, 0, { text: "" }), { id: "f", type: "file", file: "Plan.md", x: 0, y: 200, width: 100, height: 50 }],
    [{ id: "e1", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", label: "depends on" }, { id: "e2", fromNode: "f", toNode: "a" }],
  );

  it("lists each edge as 'A to B: label', and the edges SVG stays hidden from a screen reader", async () => {
    const el = await mount(withEdges());
    expect(el.querySelector(".canvas-panel")).toBeNull();
    expect(button(el, "Connections").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button(el, "Connections").click());
    expect(button(el, "Connections").getAttribute("aria-expanded")).toBe("true");
    expect([...el.querySelectorAll(".canvas-panel li")].map((li) => li.textContent)).toEqual(["card a to empty: depends on", "Plan.md to card a"]);
    expect(el.querySelector(".canvas-edges")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("selects an edge from the list, so Delete or Enter act on it from the keyboard", async () => {
    const el = await mount(withEdges());
    await act(async () => button(el, "Connections").click());
    await act(async () => (el.querySelector(".canvas-panel li button") as HTMLElement).click());
    expect(el.querySelector('.canvas-edge[data-edge-id="e1"]')!.classList.contains("on")).toBe(true);
    await key(el.querySelector(".canvas-board")!, "Delete");
    expect(last().edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("joins two cards from the form in one change, with the sides that face each other, and says why it cannot", async () => {
    const el = await mount(withEdges());
    await act(async () => button(el, "Connections").click());
    const [from, to] = [...el.querySelectorAll<HTMLSelectElement>(".canvas-connect select")];
    const pick = (select: HTMLSelectElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button(el, "Connect").disabled).toBe(true);
    await pick(from, "b");
    await pick(to, "a");
    await act(async () => button(el, "Connect").click());
    expect(changes).toHaveLength(1);
    expect(last().edges[last().edges.length - 1]).toMatchObject({ fromNode: "b", toNode: "a", fromSide: "left", toSide: "right" });
    await act(async () => button(el, "Connect").click());
    expect(changes).toHaveLength(1);
    expect(ctx.fail).toHaveBeenCalledWith("Those two sides are already joined");
  });

  it("has no joining form on a read-only board", async () => {
    const el = await mount(withEdges(), true);
    await act(async () => button(el, "Connections").click());
    expect(el.querySelector(".canvas-connect")).toBeNull();
    expect(el.querySelectorAll(".canvas-panel li")).toHaveLength(2);
  });
});

describe("axe", () => {
  it("finds nothing on a board with every kind of card, the Connections list open and a card being edited", async () => {
    const el = await mount(file([
      text("t", 0, 0), { id: "f", type: "file", file: "Plan.md", x: 200, y: 0, width: 100, height: 50 },
      { id: "l", type: "link", url: "https://example.com", x: 200, y: 80, width: 160, height: 80 },
      { id: "g", type: "group", label: "Ideas", x: 0, y: 200, width: 100, height: 50 },
    ], [{ id: "e", fromNode: "t", toNode: "f", label: "see" }]));
    await act(async () => button(el, "Connections").click());
    await expectNoNewAxeViolations(el, []);
    await focus(card(el, "t"));
    await key(card(el, "t"), "Enter");
    await expectNoNewAxeViolations(el, []);
  });
});
