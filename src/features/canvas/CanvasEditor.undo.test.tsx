// @vitest-environment jsdom
// DESKA4-UNDO (WCAG 4.1.3): Undo and Redo on the canvas board change it with no sound of their own, so a status region that
// exists from the start says what happened, and says it again when the same thing happens twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../notes/PageView", () => ({ PageView: (p: { text: string }) => <div className="markdown">{p.text}</div> }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { default: CanvasEditor } = await import("./CanvasEditor");
const { parseCanvas, writeCanvas } = await import("./model");

const read = (text: string) => { const p = parseCanvas(text); if (!p.ok) throw new Error(p.reason); return p.canvas; };
const START = writeCanvas(read(JSON.stringify({ nodes: [{ id: "a", type: "text", text: "card a", x: 0, y: 0, width: 100, height: 50 }], edges: [] })));
const ctx = {
  pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
  notebook: { files: [], url: (p: string) => p, read: vi.fn(), create: vi.fn(), save: vi.fn(), trash: vi.fn() },
};

let root: Root | null = null;
function Harness() {
  const [doc, setDoc] = useState(START);
  return <CanvasEditor text={doc} readOnly={false} ctx={ctx as never} pictures={{ base: "", folder: "", files: [] }} notebook="nb" onOpenFile={() => {}} onChange={setDoc} />;
}
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Harness />); });
  return el;
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const status = (el: ParentNode) => el.querySelector<HTMLElement>('.canvas-editor > [role="status"]')!;
const said = (el: ParentNode) => status(el).querySelector("span")!;
const button = (el: ParentNode, name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const click = (b: HTMLElement) => act(async () => { b.click(); });
const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });

describe("the canvas board's undo and redo messages", () => {
  it("has a visually hidden status region before anything is said, with no text in it", async () => {
    const el = await mount();
    expect(status(el).classList.contains("visually-hidden")).toBe(true);
    expect(status(el).textContent).toBe("");
  });

  it("says what Undo and Redo did, from the buttons and from the keys", async () => {
    const el = await mount();
    const card = el.querySelector<HTMLElement>('[data-node-id="a"]')!;
    await act(async () => card.focus());
    await key(card, "ArrowRight", { ctrlKey: true });
    expect(status(el).textContent).toBe("");
    await click(button(el, "Undo"));
    expect(status(el).textContent).toBe("Undid last change");
    await click(button(el, "Redo"));
    expect(status(el).textContent).toBe("Redid last change");
    await key(card, "z", { ctrlKey: true });
    expect(status(el).textContent).toBe("Undid last change");
    await key(card, "z", { ctrlKey: true, shiftKey: true });
    expect(status(el).textContent).toBe("Redid last change");
  });

  it("replaces the message each time, so the same words are read again", async () => {
    const el = await mount();
    const card = el.querySelector<HTMLElement>('[data-node-id="a"]')!;
    await act(async () => card.focus());
    await key(card, "ArrowRight", { ctrlKey: true });
    await click(button(el, "Undo"));
    const first = said(el);
    await click(button(el, "Redo"));
    await click(button(el, "Undo"));
    expect(said(el).textContent).toBe(first.textContent);
    expect(said(el)).not.toBe(first);
    expect(status(el).querySelectorAll("span")).toHaveLength(1);
  });

  it("has no axe violations with a message in the region", async () => {
    const el = await mount();
    const card = el.querySelector<HTMLElement>('[data-node-id="a"]')!;
    await act(async () => card.focus());
    await key(card, "ArrowRight", { ctrlKey: true });
    await click(button(el, "Undo"));
    await expectNoNewAxeViolations(el, []);
  });
});
