// @vitest-environment jsdom
// NS-7C: the board in the DOM. Gestures end in exactly one change (one step of undo), panning and zooming draw no card
// again, every kind of card draws without an iframe, a picture loads through the notebook's grant, a link opens only on a
// click, and only the board takes a page dragged from the tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const drawn = { text: 0 };
vi.mock("../notes/PageView", () => ({ PageView: (p: { text: string }) => { drawn.text++; return <div className="markdown">{p.text}</div>; } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../lib/lm", async (orig) => ({
  ...(await orig<typeof import("../../lib/lm")>()),
  read: vi.fn(async () => ({ title: "Use SQLite", type: "decision", status: "active", body: "# Heading\nWe keep one file.\nSecond line" })),
}));

const { default: CanvasEditor } = await import("./CanvasEditor");
const { dropOnBoard } = await import("./treeDrop");
const { parseCanvas, writeCanvas } = await import("./model");
const { openUrl } = await import("@tauri-apps/plugin-opener");
const { useWorkspace } = await import("../../workspace/store");

type Props = Parameters<typeof CanvasEditor>[0];
const GRANT = "http://hmfile.localhost/g1/";

const box = { width: 100, height: 50 };
const node = (id: string, x: number, y: number, extra: object = {}) => ({ id, type: "text", text: `card ${id}`, x, y, ...box, ...extra });
const read = (text: string) => { const p = parseCanvas(text); if (!p.ok) throw new Error(p.reason); return p.canvas; };
const file = (nodes: unknown[], edges: unknown[] = []) => writeCanvas(read(JSON.stringify({ nodes, edges })));

function makeCtx(files: string[] | null = ["Plan.md", "pic.png", "Doc.pdf", "Pics/my pic.png"]) {
  return {
    pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
    notebook: files && { files, url: (p: string) => `${GRANT}${p.split("/").map(encodeURIComponent).join("/")}`, read: vi.fn(), create: vi.fn(), save: vi.fn(), trash: vi.fn() },
  };
}

const PICTURES = { base: GRANT, folder: "", files: [] };
let root: Root | null = null;
let ctx = makeCtx();
const changes: string[] = [];
const opened: string[] = [];

/** A board over `text`, with the text held here as the document session holds it. */
function Harness({ initial, readOnly = false, notebook = "nb-1" }: { initial: string; readOnly?: boolean; notebook?: string }) {
  const [text, setText] = useState(initial);
  const props: Props = {
    text, readOnly, ctx: ctx as never, pictures: PICTURES, notebook, onOpenFile: (p) => { opened.push(p); },
    onChange: (t) => { changes.push(t); setText(t); },
  };
  return <CanvasEditor {...props} />;
}

async function mount(initial: string, extra: { readOnly?: boolean; notebook?: string } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Harness initial={initial} {...extra} />); });
  return el;
}

const point = (type: string, x: number, y: number, buttons = 1, extra: MouseEventInit = {}) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : buttons, bubbles: true, cancelable: true, ...extra }), { pointerId: 1 });
const fire = (el: Element | Window, e: Event) => act(async () => { el.dispatchEvent(e); });
const cardOf = (el: ParentNode, id: string) => el.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
const button = (el: ParentNode, text: string) => [...el.querySelectorAll("button")].find((b) => (b.textContent?.trim() || b.getAttribute("aria-label")) === text) as HTMLButtonElement;
const tail = <T,>(list: T[]) => list[list.length - 1];
const last = () => read(changes[changes.length - 1]);

/** A press on `target`, `steps` moves of `dx`, `dy` in all, and the release over `over` (the target by default). */
async function drag(target: Element, dx: number, dy: number, opts: { steps?: number; from?: [number, number]; over?: Element } = {}) {
  const [x, y] = opts.from ?? [10, 10], steps = opts.steps ?? 10;
  await fire(target, point("pointerdown", x, y));
  for (let i = 1; i <= steps; i++) await fire(window, point("pointermove", x + (dx * i) / steps, y + (dy * i) / steps));
  await fire(opts.over ?? target, point("pointerup", x + dx, y + dy));
}

beforeEach(() => {
  changes.length = 0; opened.length = 0; drawn.text = 0; ctx = makeCtx();
  vi.mocked(openUrl).mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("gestures are one step", () => {
  it("a drag of a card is one change however many moves it had, and one undo puts the text back as it was", async () => {
    const start = file([node("a", 0, 0), node("b", 300, 0)]);
    const el = await mount(start);
    await fire(cardOf(el, "a"), point("pointerdown", 10, 10));
    for (let i = 1; i <= 12; i++) await fire(window, point("pointermove", 10 + i * 5, 10 + i * 2));
    expect(changes).toHaveLength(0);
    // The card follows the pointer while the gesture runs; the document has not been told.
    expect(cardOf(el, "a").style.left).toBe("60px");
    await fire(window, point("pointerup", 70, 34));
    expect(changes).toHaveLength(1);
    expect(last().nodes[0]).toMatchObject({ id: "a", x: 60, y: 24 });
    expect(last().nodes[1]).toMatchObject({ id: "b", x: 300, y: 0 });
    await fire(button(el, "Undo"), new MouseEvent("click", { bubbles: true }));
    expect(changes).toHaveLength(2);
    expect(changes[1]).toBe(start);
    await fire(button(el, "Redo"), new MouseEvent("click", { bubbles: true }));
    expect(changes[2]).toBe(changes[0]);
  });

  it("a click on a card and a press that does not move change nothing", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await drag(cardOf(el, "a"), 1, 1, { steps: 1 });
    await drag(el.querySelector(".canvas-board")!, 0, 0, { steps: 0 });
    expect(changes).toHaveLength(0);
  });

  it("a drag of a group takes the cards inside it, and one outside stays", async () => {
    const el = await mount(file([node("g", 0, 0, { type: "group", width: 400, height: 300, text: undefined }), node("in", 20, 20), node("out", 600, 20)]));
    await drag(cardOf(el, "g"), 50, 30);
    expect(changes).toHaveLength(1);
    expect(last().nodes.map((n) => [n.id, n.x, n.y])).toEqual([["g", 50, 30], ["in", 70, 50], ["out", 600, 20]]);
  });

  it("a corner drag resizes one card in one change, and never below the smallest size", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await drag(cardOf(el, "a"), 0, 0, { steps: 0 });
    await drag(cardOf(el, "a").querySelector('[data-resize="se"]')!, 60, 30);
    expect(changes).toHaveLength(1);
    expect(last().nodes[0]).toMatchObject({ x: 0, y: 0, width: 160, height: 80 });
    await drag(cardOf(el, "a").querySelector('[data-resize="se"]')!, -900, -900);
    expect(last().nodes[0]).toMatchObject({ width: 60, height: 40 });
    expect(changes).toHaveLength(2);
  });

  it("a gesture whose release was never seen ends when the pointer comes back with no button down", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await fire(cardOf(el, "a"), point("pointerdown", 10, 10));
    await fire(window, point("pointermove", 50, 10));
    await fire(window, point("pointermove", 90, 10, 0));
    expect(changes).toHaveLength(0);
    expect(cardOf(el, "a").style.left).toBe("0px");
  });

  it("the Delete key removes the selected card and its edges in one change, and Ctrl+Z brings them back", async () => {
    const start = file([node("a", 0, 0), node("b", 300, 0)], [{ id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }]);
    const el = await mount(start);
    await drag(cardOf(el, "a"), 0, 0, { steps: 0 });
    const board = el.querySelector(".canvas-board")!;
    await fire(board, new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(changes).toHaveLength(1);
    expect(last().nodes.map((n) => n.id)).toEqual(["b"]);
    expect(last().edges).toEqual([]);
    await fire(board, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(changes[1]).toBe(start);
  });
});

describe("edges", () => {
  const two = () => file([node("a", 0, 0), node("b", 300, 0)]);

  it("dragging from a side handle to another card joins them in one change, with the side nearest the release", async () => {
    const el = await mount(two());
    await drag(cardOf(el, "a").querySelector('[data-handle="right"]')!, 195, 0, { from: [100, 25], over: cardOf(el, "b") });
    expect(changes).toHaveLength(1);
    expect(last().edges).toEqual([expect.objectContaining({ fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" })]);
    expect(el.querySelectorAll(".canvas-edge")).toHaveLength(1);
    expect(el.querySelector(".canvas-arrow")).not.toBeNull();
  });

  it("a release on a card that is the same card, or on empty space, makes no edge", async () => {
    const el = await mount(two());
    await drag(cardOf(el, "a").querySelector('[data-handle="right"]')!, 0, 0, { from: [100, 25], over: cardOf(el, "a") });
    await drag(cardOf(el, "a").querySelector('[data-handle="right"]')!, 100, 200, { from: [100, 25], over: el.querySelector(".canvas-board")! });
    expect(changes).toHaveLength(0);
    // A release on the card it started from is an accident, not a mistake worth a message.
    expect(ctx.fail).not.toHaveBeenCalled();
    // A join that is already there is said.
    await drag(cardOf(el, "a").querySelector('[data-handle="right"]')!, 195, 0, { from: [100, 25], over: cardOf(el, "b") });
    await drag(cardOf(el, "a").querySelector('[data-handle="right"]')!, 195, 0, { from: [100, 25], over: cardOf(el, "b") });
    expect(changes).toHaveLength(1);
    expect(ctx.fail).toHaveBeenCalledWith(expect.stringMatching(/already joined/));
  });

  it("a label is edited by double-clicking the edge, and written in one change; an empty label removes it", async () => {
    const start = file([node("a", 0, 0), node("b", 300, 0)], [{ id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left", color: "4", extra: { kept: 1 } }]);
    const el = await mount(start);
    await fire(el.querySelector(".canvas-edge-hit")!, new MouseEvent("dblclick", { bubbles: true }));
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Edge label"]')!;
    expect(input).not.toBeNull();
    input.value = "depends on";
    await fire(input, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(changes).toHaveLength(1);
    expect(last().edges[0]).toMatchObject({ id: "e", label: "depends on", color: "4", extra: { kept: 1 } });
    expect(el.querySelector(".canvas-edge-label")?.textContent).toBe("depends on");
    // Escape gives the edit up.
    await fire(el.querySelector(".canvas-edge-label")!, new MouseEvent("dblclick", { bubbles: true }));
    const again = el.querySelector<HTMLInputElement>('input[aria-label="Edge label"]')!;
    again.value = "nope";
    await fire(again, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(changes).toHaveLength(1);
    // Emptied, the label is gone from the file.
    await fire(el.querySelector(".canvas-edge-label")!, new MouseEvent("dblclick", { bubbles: true }));
    const empty = el.querySelector<HTMLInputElement>('input[aria-label="Edge label"]')!;
    empty.value = "";
    await fire(empty, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(last().edges[0]).not.toHaveProperty("label");
  });

  it("an edge to a card that is not there is not drawn, is said, and stays in the file", async () => {
    const el = await mount(file([node("a", 0, 0)], [{ id: "e", fromNode: "a", toNode: "ghost" }]));
    expect(el.querySelectorAll(".canvas-edge")).toHaveLength(0);
    expect(el.querySelector(".canvas-note")?.textContent).toMatch(/1 edge joins a card that is not on the board/);
    await drag(cardOf(el, "a"), 20, 0);
    expect(last().edges).toHaveLength(1);
  });
});

describe("cards", () => {
  it("a text card is edited in place and written when it loses focus; Escape gives the edit up", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await fire(cardOf(el, "a"), new MouseEvent("dblclick", { bubbles: true }));
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(area.value).toBe("card a");
    area.value = "# New\n\nbody";
    await act(async () => { area.focus(); area.blur(); });
    expect(changes).toHaveLength(1);
    expect(last().nodes[0].text).toBe("# New\n\nbody");
    await fire(cardOf(el, "a"), new MouseEvent("dblclick", { bubbles: true }));
    const again = el.querySelector<HTMLTextAreaElement>("textarea")!;
    again.value = "dropped";
    await fire(again, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(changes).toHaveLength(1);
  });

  it("pressing on another card while one is being edited writes the edit and starts no drag from the board as it was", async () => {
    const el = await mount(file([node("a", 0, 0), node("b", 300, 0)]));
    await fire(cardOf(el, "a"), new MouseEvent("dblclick", { bubbles: true }));
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    area.value = "typed";
    await drag(cardOf(el, "b"), 60, 0);
    expect(changes).toHaveLength(1);
    expect(last().nodes.map((n) => [n.id, n.x, n.text])).toEqual([["a", 0, "typed"], ["b", 300, "card b"]]);
  });

  it("double-clicking empty space adds a text card there and opens it for typing", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await fire(el.querySelector(".canvas-board")!, new MouseEvent("dblclick", { bubbles: true, clientX: 500, clientY: 400 }));
    expect(changes).toHaveLength(1);
    expect(last().nodes).toHaveLength(2);
    expect(last().nodes[1]).toMatchObject({ type: "text", x: 370, y: 340, width: 260, height: 120 });
    expect(el.querySelector("textarea")).not.toBeNull();
  });

  it("every kind of card draws, and none of them is an iframe", async () => {
    const el = await mount(file([
      node("t", 0, 0), node("g", 0, 100, { type: "group", label: "Ideas", text: undefined }),
      node("f", 200, 0, { type: "file", file: "Plan.md", subpath: "#Goals", text: undefined }),
      node("p", 200, 100, { type: "file", file: "Doc.pdf", text: undefined }),
      node("i", 200, 200, { type: "file", file: "pic.png", text: undefined }),
      node("l", 400, 0, { type: "link", url: "https://example.com/some/page", text: undefined }),
      node("w", 400, 100, { type: "widget", text: undefined }),
    ]));
    expect(el.querySelectorAll(".canvas-node")).toHaveLength(7);
    expect(el.querySelector(".canvas-file .canvas-title")?.textContent).toBe("Plan");
    expect(el.textContent).toContain("Ideas");
    expect(el.textContent).toContain("PDF");
    expect(el.textContent).toContain("This kind of card is kept but not drawn here.");
    expect(document.querySelector("iframe")).toBeNull();
    expect(el.innerHTML.toLowerCase()).not.toContain("<iframe");
  });

  it("a picture loads through the notebook's grant, by the path from its root, and a missing one says so", async () => {
    const el = await mount(file([node("i", 0, 0, { type: "file", file: "Pics/my pic.png", text: undefined })]));
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`${GRANT}Pics/my%20pic.png`);
    expect(img.src.startsWith("http://hmfile.localhost/")).toBe(true);
    await fire(img, new Event("error"));
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("Picture not found");
  });

  it("a picture is not loaded from anywhere when the board has no notebook (a loose file)", async () => {
    ctx = makeCtx(null);
    const el = await mount(file([node("i", 0, 0, { type: "file", file: "pic.png", text: undefined })]));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".canvas-file")).not.toBeNull();
  });

  it("a file card whose file is not in the notebook says so, and double-clicking one opens the file", async () => {
    const el = await mount(file([node("f", 0, 0, { type: "file", file: "Gone.md", text: undefined }), node("p", 200, 0, { type: "file", file: "plan.md", text: undefined })]));
    expect(cardOf(el, "f").textContent).toContain("Not found in this notebook");
    expect(cardOf(el, "p").textContent).not.toContain("Not found");
    await fire(cardOf(el, "p"), new MouseEvent("dblclick", { bubbles: true }));
    expect(opened).toEqual(["plan.md"]);
  });

  it("a link card shows its host and address and opens in the browser only on a click of its button", async () => {
    const el = await mount(file([node("l", 0, 0, { type: "link", url: "https://example.com/some/page?q=1", text: undefined })]));
    expect(cardOf(el, "l").querySelector(".canvas-title")?.textContent).toBe("example.com");
    expect(cardOf(el, "l").textContent).toContain("https://example.com/some/page?q=1");
    // Selecting, double-clicking and drawing it open nothing.
    await drag(cardOf(el, "l"), 0, 0, { steps: 0 });
    expect(openUrl).not.toHaveBeenCalled();
    await fire(button(el, "Open in browser"), new MouseEvent("click", { bubbles: true }));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/some/page?q=1");
  });

  it("a link card with an address that is not the web or mail is never opened", async () => {
    const el = await mount(file([node("l", 0, 0, { type: "link", url: "file:///C:/Windows/notepad.exe", text: undefined }), node("m", 200, 0, { type: "link", url: "javascript:alert(1)", text: undefined })]));
    expect(el.querySelectorAll("button.canvas-open")).toHaveLength(0);
    expect(el.textContent).toContain("This address is not opened from here.");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("a Memory note card is drawn from the note, and its title opens the note", async () => {
    const open = vi.spyOn(useWorkspace.getState(), "openNote").mockImplementation(() => {});
    const el = await mount(file([node("m", 0, 0, { type: "link", url: "hivemind:mem:note-1", text: undefined })]));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(el.textContent).toContain("Use SQLite");
    expect(el.textContent).toContain("decision · active");
    expect(el.textContent).toContain("We keep one file.");
    expect(el.textContent).not.toContain("# Heading");
    expect(el.textContent).not.toContain("hivemind:mem:");
    await fire(button(el, "Use SQLite"), new MouseEvent("click", { bubbles: true }));
    expect(open).toHaveBeenCalledWith("note-1", {});
    open.mockRestore();
  });
});

describe("pan and zoom", () => {
  const many = (n: number) => file(Array.from({ length: n }, (_, i) => node(`n${i}`, (i % 25) * 130, Math.floor(i / 25) * 70)));
  const world = (el: ParentNode) => el.querySelector<HTMLElement>(".canvas-world")!;

  it("panning with the wheel and zooming with Ctrl and the wheel move the world, and draw none of 500 cards again", async () => {
    const el = await mount(many(500));
    expect(el.querySelectorAll(".canvas-node")).toHaveLength(500);
    const before = drawn.text;
    expect(before).toBeGreaterThanOrEqual(500);
    const board = el.querySelector(".canvas-board")!;
    const start = world(el).style.transform;
    const plain = new WheelEvent("wheel", { deltaX: 10, deltaY: 40, bubbles: true, cancelable: true });
    await fire(board, plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(world(el).style.transform).toBe("translate(-10px, -40px) scale(1)");
    for (let i = 0; i < 20; i++) await fire(board, new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 100, bubbles: true, cancelable: true }));
    await fire(button(el, "−"), new MouseEvent("click", { bubbles: true }));
    expect(world(el).style.transform).not.toBe(start);
    expect(el.querySelector(".canvas-zoom")?.textContent).toBe("240%");
    await fire(button(el, "Fit"), new MouseEvent("click", { bubbles: true }));
    expect(drawn.text).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it("dragging one of 500 cards draws that card again and not the others", async () => {
    const el = await mount(many(500));
    const before = drawn.text;
    await drag(cardOf(el, "n7"), 80, 40, { steps: 10 });
    expect(changes).toHaveLength(1);
    // The card pressed (selected, then moved 10 times, then written): a few draws of one card, never 500.
    expect(drawn.text - before).toBeLessThan(30);
  });

  it("dragging empty space pans without a change to the file, and Ctrl+wheel keeps the point under the pointer", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await drag(el.querySelector(".canvas-board")!, 70, 30);
    expect(world(el).style.transform).toBe("translate(70px, 30px) scale(1)");
    expect(changes).toHaveLength(0);
    await fire(el.querySelector(".canvas-board")!, new WheelEvent("wheel", { deltaY: -346.57, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    // e^(0.6931) = 2: the canvas point (30, 70) that was at (100, 100) stays there.
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world(el).style.transform)!;
    expect(Number(m[3])).toBeCloseTo(2, 2);
    expect(30 * Number(m[3]) + Number(m[1])).toBeCloseTo(100, 0);
    expect(70 * Number(m[3]) + Number(m[2])).toBeCloseTo(100, 0);
  });
});

describe("a page dragged from the tree", () => {
  const over = (el: Element) => { (document as { elementFromPoint?: unknown }).elementFromPoint = vi.fn(() => el); };

  it("is put on the board where it is let go, as a file card of the notebook's own path", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    over(cardOf(el, "a"));
    expect(dropOnBoard({ notebook: "nb-1", path: "Notes/Plan.md" }, 400, 300)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(last().nodes[1]).toMatchObject({ type: "file", file: "Notes/Plan.md", x: 260, y: 220, width: 280, height: 160 });
    expect(el.querySelector(".canvas-board")).not.toBeNull();
  });

  it("a picture dropped gets the picture's size", async () => {
    await mount(file([]));
    over(document.querySelector(".canvas-board")!);
    dropOnBoard({ notebook: "nb-1", path: "pic.png" }, 0, 0);
    expect(last().nodes[0]).toMatchObject({ file: "pic.png", width: 320, height: 240 });
  });

  it("is refused from another notebook, and on a read-only board, and nothing else takes it", async () => {
    await mount(file([node("a", 0, 0)]));
    over(document.querySelector(".canvas-board")!);
    dropOnBoard({ notebook: "nb-2", path: "Plan.md" }, 0, 0);
    expect(changes).toHaveLength(0);
    expect(ctx.fail).toHaveBeenCalledWith(expect.stringMatching(/only files of this notebook/i));
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    ctx = makeCtx();
    await mount(file([node("a", 0, 0)]), { readOnly: true });
    over(document.querySelector(".canvas-board")!);
    dropOnBoard({ notebook: "nb-1", path: "Plan.md" }, 0, 0);
    expect(changes).toHaveLength(0);
    expect(ctx.fail).toHaveBeenCalledWith(expect.stringMatching(/read-only/));
  });

  it("is ignored anywhere that is not a board, and after the board is gone", async () => {
    await mount(file([node("a", 0, 0)]));
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    over(elsewhere);
    expect(dropOnBoard({ notebook: "nb-1", path: "Plan.md" }, 0, 0)).toBe(false);
    expect(changes).toHaveLength(0);
    await act(async () => root?.unmount());
    root = null;
    over(document.body);
    expect(dropOnBoard({ notebook: "nb-1", path: "Plan.md" }, 0, 0)).toBe(false);
  });
});

describe("a read-only board", () => {
  it("pans and zooms and selects, but moves, resizes, joins and deletes nothing and offers no way to add", async () => {
    const el = await mount(file([node("a", 0, 0), node("b", 300, 0)]), { readOnly: true });
    expect(el.querySelectorAll("[data-handle]")).toHaveLength(0);
    expect(button(el, "Text")).toBeUndefined();
    await drag(cardOf(el, "a"), 50, 50);
    await fire(el.querySelector(".canvas-board")!, new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await fire(cardOf(el, "a"), new MouseEvent("dblclick", { bubbles: true }));
    expect(el.querySelector("textarea")).toBeNull();
    expect(changes).toHaveLength(0);
    await fire(button(el, "+"), new MouseEvent("click", { bubbles: true }));
    expect(el.querySelector(".canvas-zoom")?.textContent).toBe("125%");
  });
});

describe("adding", () => {
  it("each Add button makes its card in one change, in the middle of the pane, and a group goes behind the others", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await fire(button(el, "Text"), new MouseEvent("click", { bubbles: true }));
    expect(tail(last().nodes)).toMatchObject({ type: "text", text: "" });
    await fire(button(el, "Link"), new MouseEvent("click", { bubbles: true }));
    expect(tail(last().nodes)).toMatchObject({ type: "link", url: "" });
    await fire(button(el, "Group"), new MouseEvent("click", { bubbles: true }));
    expect(last().nodes[0]).toMatchObject({ type: "group" });
    expect(changes).toHaveLength(3);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("File lists the notebook's files and puts the one picked on the board", async () => {
    const el = await mount(file([]));
    await fire(button(el, "File"), new MouseEvent("click", { bubbles: true }));
    const row = [...document.querySelectorAll(".hm-pick-list button")].find((b) => b.textContent === "Plan.md")!;
    await fire(row, new MouseEvent("click", { bubbles: true }));
    expect(last().nodes[0]).toMatchObject({ type: "file", file: "Plan.md" });
  });

  it("a card is coloured with a preset in one change, and the colour can be taken off", async () => {
    const el = await mount(file([node("a", 0, 0)]));
    await drag(cardOf(el, "a"), 0, 0, { steps: 0 });
    await fire(button(el, "Colour green"), new MouseEvent("click", { bubbles: true }));
    expect(last().nodes[0].color).toBe("4");
    expect(cardOf(el, "a").className).toContain("canvas-c-green");
    await fire(button(el, "No colour"), new MouseEvent("click", { bubbles: true }));
    expect(last().nodes[0]).not.toHaveProperty("color");
  });
});
