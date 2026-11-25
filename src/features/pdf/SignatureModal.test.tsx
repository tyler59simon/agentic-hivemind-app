// @vitest-environment jsdom
// DESKA3-SIGN (WCAG 2.5.7): a signature can be typed as well as drawn, and both give the same kind of PNG data URL.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";
import { SIGNATURE_FONT, SignatureModal } from "./SignatureModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.setPointerCapture = () => {};

// jsdom has no canvas: a recording stand-in for the 2D context, and a data URL that says what was on the canvas last.
const calls: string[] = [];
let width = 0;
const ctx = {
  clearRect: () => calls.push("clear"),
  measureText: (t: string) => ({ width: t.length * Number(/(\d+)px/.exec(ctx.font)![1]) * 0.5 }),
  fillText: (t: string, x: number, y: number) => calls.push(`text ${t} ${x},${y} ${ctx.font} ${ctx.fillStyle}`),
  beginPath: () => calls.push("begin"), moveTo: () => {}, lineTo: () => {}, stroke: () => calls.push("stroke"),
  font: "", fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "", textAlign: "", textBaseline: "",
};

let root: Root | null = null;
let applied: string[] = [];
let closed = 0;
beforeEach(async () => {
  calls.length = 0;
  applied = [];
  closed = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) { width = this.width; return `data:image/png;base64,${calls.filter((c) => c.startsWith("text")).length}`; });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<SignatureModal onClose={() => { closed++; }} onApply={(url) => applied.push(url)} />));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

const lastText = () => calls.filter((c) => c.startsWith("text")).pop()!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const radio = (value: string) => dialog().querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!;
const place = () => [...dialog().querySelectorAll("button")].find((b) => b.textContent === "Place signature")!;
const field = () => dialog().querySelector<HTMLInputElement>('input:not([type=radio])')!;
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the signature modal", () => {
  it("offers Draw and Type as a named radio group, Draw first", () => {
    const group = dialog().querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("How to make the signature");
    expect([...group.querySelectorAll("label")].map((l) => l.textContent)).toEqual(["Draw", "Type"]);
    expect([radio("draw").checked, radio("type").checked]).toEqual([true, false]);
    expect(dialog().querySelector("input:not([type=radio])")).toBeNull();
  });

  it("draws a signature as before: nothing to place until a stroke is made", async () => {
    expect((place() as HTMLButtonElement).disabled).toBe(true);
    const canvas = dialog().querySelector("canvas")!;
    await act(async () => { canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 })); });
    expect((place() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => place().click());
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("types a name onto a canvas of the same size, in the signature font and the ink colour, and places it as a PNG data URL", async () => {
    await act(async () => radio("type").click());
    expect((place() as HTMLButtonElement).disabled).toBe(true);
    await type("Ada Lovelace");
    const text = lastText();
    expect(text).toContain("text Ada Lovelace 240,90");
    expect(text).toContain(SIGNATURE_FONT);
    expect(text.endsWith("#111827")).toBe(true);
    expect((place() as HTMLButtonElement).disabled).toBe(false);
    await act(async () => place().click());
    expect(applied).toEqual(["data:image/png;base64,1"]);
    expect(applied[0]).toMatch(/^data:image\/png;base64,/);
    const canvas = dialog().querySelector("canvas")!;
    expect([canvas.width, canvas.height, width]).toEqual([480, 180, 480]);
  });

  it("cannot place an empty or blank name", async () => {
    await act(async () => radio("type").click());
    expect((place() as HTMLButtonElement).disabled).toBe(true);
    await type("   ");
    expect((place() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => place().click());
    expect(applied).toEqual([]);
    await act(async () => { field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(applied).toEqual([]);
  });

  it("places a typed name with Enter, and shrinks a long name to fit the canvas", async () => {
    await act(async () => radio("type").click());
    await type("A very long name that is much too wide for the pad at the first size tried");
    const text = lastText();
    expect(Number(/italic (\d+)px/.exec(text)![1])).toBeLessThan(84);
    await act(async () => { field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(applied).toHaveLength(1);
  });

  it("does not keep a typed name's ink when the person goes back to Draw", async () => {
    await act(async () => radio("type").click());
    await type("Ada");
    await act(async () => radio("draw").click());
    expect((place() as HTMLButtonElement).disabled).toBe(true);
    expect(calls[calls.length - 1]).toBe("clear");
  });

  it("has no axe violations in either way", async () => {
    await expectNoNewAxeViolations(dialog(), []);
    await act(async () => radio("type").click());
    await type("Ada");
    await expectNoNewAxeViolations(dialog(), []);
  });
});
