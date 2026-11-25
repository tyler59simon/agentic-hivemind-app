// @vitest-environment jsdom
// DESK-A11Y A3: the draw.io board without a pointer. One shape is the Tab stop and the arrow keys walk the shapes in reading order;
// every shape has a name; Enter edits and Escape leaves an edit with focus back on the shape; Ctrl+Arrow and Ctrl+Shift+Arrow move
// and resize through the same commit as a drag (WCAG 2.5.7); the Cells list names every shape with its connections and a form joins
// two shapes; the edges SVG is hidden from a screen reader; axe finds nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expectNoNewAxeViolations } from "../../test/axe";
import DrawioEditor from "./DrawioEditor";
import { parseDrawio } from "./xml";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const cell = (id: string, label: string, x: number, y: number) =>
  `<mxCell id="${id}" value="${label}" style="rounded=1;fillColor=#edf6ff;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="140" height="70" as="geometry" /></mxCell>`;
// Reading order is top to bottom, then left to right: a (40,40), b (260,40), c (40,200).
const SAMPLE = `<mxfile host="Test"><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />${
  cell("c", "Cache", 40, 200)}${cell("b", "DB", 260, 40)}${cell("a", "API", 40, 40)
}<mxCell id="e1" value="reads" style="endArrow=block;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell><mxCell id="e2" style="endArrow=block;" edge="1" parent="1" source="c" target="a"><mxGeometry relative="1" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>`;

let root: Root | null = null;
const changes: string[] = [];

function Harness({ readOnly = false }: { readOnly?: boolean }) {
  const [text, setText] = useState(SAMPLE);
  return <DrawioEditor text={text} readOnly={readOnly} fileName="a.drawio" onChange={(t) => { changes.push(t); setText(t); }} />;
}
async function mount(readOnly = false) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Harness readOnly={readOnly} />); });
  return el;
}
const node = (el: ParentNode, id: string) => el.querySelector(`[data-drawio-cell="${id}"]`) as HTMLElement;
const key = (target: Element, k: string, mods: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods })); });
const focus = (target: HTMLElement) => act(async () => { target.focus(); });
const active = () => (document.activeElement as HTMLElement | null)?.dataset.drawioCell ?? document.activeElement?.className;
const geometry = (id: string) => {
  const p = parseDrawio(changes[changes.length - 1]);
  if (!p.ok) throw new Error(p.reason);
  const g = p.doc.pages[0].cells.find((c) => c.id === id)!.geometry!;
  return { x: g.x, y: g.y, width: g.width, height: g.height };
};
const button = (el: ParentNode, name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

beforeEach(() => { changes.length = 0; });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the board", () => {
  it("is an application named for its page, with its edges hidden from a screen reader", async () => {
    const el = await mount();
    const board = el.querySelector(".drawio-board")!;
    expect(board.getAttribute("role")).toBe("application");
    expect(board.getAttribute("aria-label")).toBe("Diagram board, page Overview");
    expect(el.querySelector("svg.drawio-edges")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("names each shape, and has one Tab stop, the first in reading order", async () => {
    const el = await mount();
    const names = Object.fromEntries([...el.querySelectorAll("[data-drawio-cell]")].map((n) => [(n as HTMLElement).dataset.drawioCell, n.getAttribute("aria-label")]));
    expect(names).toEqual({ a: "Shape: API", b: "Shape: DB", c: "Shape: Cache" });
    expect([...el.querySelectorAll<HTMLElement>("[data-drawio-cell]")].filter((n) => n.tabIndex === 0).map((n) => n.dataset.drawioCell)).toEqual(["a"]);
    expect(el.querySelector<HTMLElement>(".drawio-shell")!.tabIndex).toBe(-1);
  });
});

describe("walking the shapes", () => {
  it("moves focus and selection in reading order with the arrow keys, and to the ends with Home and End", async () => {
    const el = await mount();
    await focus(node(el, "a"));
    expect(node(el, "a").classList.contains("on")).toBe(true);
    await key(node(el, "a"), "ArrowRight");
    expect(active()).toBe("b");
    await key(node(el, "b"), "ArrowDown");
    expect(active()).toBe("c");
    expect(node(el, "c").classList.contains("on")).toBe(true);
    expect(node(el, "b").classList.contains("on")).toBe(false);
    await key(node(el, "c"), "ArrowRight");
    expect(active()).toBe("c");
    await key(node(el, "c"), "Home");
    expect(active()).toBe("a");
    await key(node(el, "a"), "End");
    expect(active()).toBe("c");
    expect(changes).toHaveLength(0);
  });
});

describe("editing and deleting", () => {
  it("Enter edits the label; Escape gives the edit up and puts focus back on the shape", async () => {
    const el = await mount();
    await focus(node(el, "b"));
    await key(node(el, "b"), "Enter");
    const area = el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(area);
    await key(area, "Escape");
    expect(el.querySelector("textarea")).toBeNull();
    expect(active()).toBe("b");
    expect(changes).toHaveLength(0);
    await key(node(el, "b"), "F2");
    expect(el.querySelector("textarea")).not.toBeNull();
  });

  it("Delete removes the shape and puts focus on the next one; Ctrl+Z brings it back", async () => {
    const el = await mount();
    await focus(node(el, "b"));
    await key(node(el, "b"), "Delete");
    expect(active()).toBe("c");
    expect(el.querySelector("[data-drawio-cell='b']")).toBeNull();
    await key(node(el, "c"), "z", { ctrlKey: true });
    expect(el.querySelector("[data-drawio-cell='b']")).not.toBeNull();
  });
});

describe("moving and resizing without a drag", () => {
  it("Ctrl+Arrow moves the shape by 8 in one change; Cmd works too", async () => {
    const el = await mount();
    await focus(node(el, "b"));
    await key(node(el, "b"), "ArrowRight", { ctrlKey: true });
    expect(changes).toHaveLength(1);
    expect(geometry("b")).toEqual({ x: 268, y: 40, width: 140, height: 70 });
    await key(node(el, "b"), "ArrowUp", { metaKey: true });
    expect(geometry("b")).toMatchObject({ x: 268, y: 32 });
    expect(geometry("a")).toMatchObject({ x: 40, y: 40 });
  });

  it("Ctrl+Shift+Arrow resizes from the bottom right corner, on the grid", async () => {
    const el = await mount();
    await focus(node(el, "a"));
    await key(node(el, "a"), "ArrowRight", { ctrlKey: true, shiftKey: true });
    await key(node(el, "a"), "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(geometry("a")).toMatchObject({ x: 40, y: 40, width: 152, height: 80 });
  });

  it("a run of presses is one step of undo", async () => {
    const el = await mount();
    await focus(node(el, "a"));
    for (let i = 0; i < 5; i++) await key(node(el, "a"), "ArrowDown", { ctrlKey: true });
    expect(geometry("a").y).toBe(80);
    await key(node(el, "a"), "z", { ctrlKey: true });
    expect(changes[changes.length - 1]).toBe(SAMPLE);
  });

  it("does nothing on a read-only board", async () => {
    const el = await mount(true);
    await focus(node(el, "a"));
    await key(node(el, "a"), "ArrowRight", { ctrlKey: true });
    await key(node(el, "a"), "ArrowRight", { ctrlKey: true, shiftKey: true });
    await key(node(el, "a"), "Delete");
    expect(changes).toHaveLength(0);
  });
});

describe("the cells list", () => {
  it("lists every shape with the arrows that join it as 'A to B: label'", async () => {
    const el = await mount();
    expect(el.querySelector(".canvas-panel")).toBeNull();
    expect(button(el, "Cells").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button(el, "Cells").click());
    expect(button(el, "Cells").getAttribute("aria-expanded")).toBe("true");
    const rows = [...el.querySelectorAll(".canvas-panel > ul > li")].map((li) => [li.querySelector(":scope > button")!.textContent, [...li.querySelectorAll("li")].map((c) => c.textContent)]);
    expect(rows).toEqual([
      ["Cache", ["Cache to API"]], ["DB", ["API to DB: reads"]], ["API", ["API to DB: reads", "Cache to API"]],
    ]);
  });

  it("picks a shape from the list, and an arrow, so Delete acts on it from the keyboard", async () => {
    const el = await mount();
    await act(async () => button(el, "Cells").click());
    await act(async () => button(el, "DB").click());
    expect(node(el, "b").classList.contains("on")).toBe(true);
    expect(active()).toBe("b");
    await act(async () => (el.querySelector(".canvas-panel li li button") as HTMLElement).click());
    await key(document.activeElement!, "Delete");
    const p = parseDrawio(changes[changes.length - 1]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.doc.pages[0].cells.filter((c) => c.edge).map((c) => c.id)).toEqual(["e1"]);
    expect(p.doc.pages[0].cells.filter((c) => c.vertex)).toHaveLength(3);
  });

  it("joins two shapes from the form in one change", async () => {
    const el = await mount();
    await act(async () => button(el, "Cells").click());
    const [from, to] = [...el.querySelectorAll<HTMLSelectElement>(".canvas-connect select")];
    const pick = (select: HTMLSelectElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button(el, "Connect").disabled).toBe(true);
    await pick(from, "b");
    await pick(to, "c");
    await act(async () => button(el, "Connect").click());
    expect(changes).toHaveLength(1);
    const p = parseDrawio(changes[0]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.doc.pages[0].cells.filter((c) => c.edge).map((c) => [c.source, c.target])).toEqual([["a", "b"], ["c", "a"], ["b", "c"]]);
  });

  it("has no joining form on a read-only board", async () => {
    const el = await mount(true);
    await act(async () => button(el, "Cells").click());
    expect(el.querySelector(".canvas-connect")).toBeNull();
    expect(el.querySelectorAll(".canvas-panel > ul > li")).toHaveLength(3);
  });
});

describe("axe", () => {
  it("finds nothing on the board, with the Cells list open and a label being edited", async () => {
    const el = await mount();
    await expectNoNewAxeViolations(el, []);
    await act(async () => button(el, "Cells").click());
    await expectNoNewAxeViolations(el, []);
    await focus(node(el, "a"));
    await key(node(el, "a"), "Enter");
    await expectNoNewAxeViolations(el, []);
  });
});
