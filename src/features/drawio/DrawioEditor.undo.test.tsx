// @vitest-environment jsdom
// DESKA4-UNDO (WCAG 4.1.3): Undo and Redo on the draw.io board say what happened in a status region that exists from the start.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expectNoNewAxeViolations } from "../../test/axe";
import DrawioEditor from "./DrawioEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const START = `<mxfile host="Test"><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="API" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="70" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>`;

let root: Root | null = null;
function Harness() {
  const [text, setText] = useState(START);
  return <DrawioEditor text={text} readOnly={false} fileName="a.drawio" onChange={setText} />;
}
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Harness />); });
  return el;
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const status = (el: ParentNode) => el.querySelector<HTMLElement>('.drawio-editor > [role="status"]')!;
const said = (el: ParentNode) => status(el).querySelector("span")!;
const button = (el: ParentNode, name: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const click = (b: HTMLElement) => act(async () => { b.click(); });
const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
const change = async (el: ParentNode) => {
  const shape = el.querySelector<HTMLElement>('[data-drawio-cell="a"]')!;
  await act(async () => shape.focus());
  await key(shape, "ArrowRight", { ctrlKey: true });
  return shape;
};

describe("the draw.io board's undo and redo messages", () => {
  it("has a visually hidden status region before anything is said, with no text in it", async () => {
    const el = await mount();
    expect(status(el).classList.contains("visually-hidden")).toBe(true);
    expect(status(el).textContent).toBe("");
  });

  it("says what Undo and Redo did, from the buttons and from the keys", async () => {
    const el = await mount();
    const shape = await change(el);
    expect(status(el).textContent).toBe("");
    await click(button(el, "Undo"));
    expect(status(el).textContent).toBe("Undid last change");
    await click(button(el, "Redo"));
    expect(status(el).textContent).toBe("Redid last change");
    await key(shape, "z", { ctrlKey: true });
    expect(status(el).textContent).toBe("Undid last change");
    await key(shape, "z", { ctrlKey: true, shiftKey: true });
    expect(status(el).textContent).toBe("Redid last change");
  });

  it("replaces the message each time, so the same words are read again", async () => {
    const el = await mount();
    await change(el);
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
    await change(el);
    await click(button(el, "Undo"));
    await expectNoNewAxeViolations(el, []);
  });
});
