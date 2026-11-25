// @vitest-environment jsdom
// DESKA3-DRAWIO-WRAP: the toolbar and the selected-shape style bar are laid out one after the other in the same box (see toolbar.css.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DrawioEditor from "./DrawioEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const SAMPLE = `<mxfile host="Test"><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="API" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="70" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>`;

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Draw.io tool bars", () => {
  it("puts the style bar after the toolbar in one box, and shows it only while a shape is selected", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => { root!.render(<DrawioEditor text={SAMPLE} readOnly={false} fileName="a.drawio" onChange={() => {}} />); });
    const box = el.querySelector(".drawio-tools")!;
    expect([...box.children].map((c) => c.getAttribute("aria-label"))).toEqual(["Draw.io toolbar"]);
    await act(async () => el.querySelector<HTMLElement>('[data-drawio-cell="a"]')!.focus());
    expect([...box.children].map((c) => c.getAttribute("aria-label"))).toEqual(["Draw.io toolbar", "Selection style"]);
    // Both are still toolbars, so a press on either does not start a pan of the board.
    expect([...box.children].every((c) => c.classList.contains("canvas-tools"))).toBe(true);
  });
});
