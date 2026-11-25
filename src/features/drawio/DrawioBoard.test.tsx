// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DrawioEditor from "./DrawioEditor";
import { parseDrawio } from "./xml";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const SAMPLE = `<mxfile host="Test"><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="API" style="rounded=1;fillColor=#edf6ff;strokeColor=#438dd5;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="70" as="geometry" /></mxCell><mxCell id="b" value="DB" style="shape=cylinder3;fillColor=#eaf6ec;strokeColor=#2e7d32;" vertex="1" parent="1"><mxGeometry x="260" y="40" width="120" height="80" as="geometry" /></mxCell><mxCell id="e1" value="reads" style="endArrow=block;strokeColor=#526580;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>`;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("DrawioEditor component", () => {
  it("renders shapes, edges, and page tabs without an iframe, and commits XML on adding a shape", async () => {
    let latest = SAMPLE;
    const onChange = vi.fn((next: string) => { latest = next; });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<DrawioEditor text={latest} readOnly={false} fileName="arch.drawio" onChange={onChange} />);
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(el.querySelectorAll("[data-drawio-cell]")).toHaveLength(2);
    expect(el.textContent).toContain("API");
    expect(el.textContent).toContain("DB");
    expect(el.textContent).toContain("reads");
    expect(el.textContent).toContain("Overview");

    const addBtn = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "+ Box")!;
    await act(async () => { addBtn.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const parsed = parseDrawio(latest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.doc.pages[0].cells.filter((c) => c.vertex)).toHaveLength(3);
  });

  it("calls onInvalid and renders no iframe for malformed XML", async () => {
    const onInvalid = vi.fn();
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<DrawioEditor text="<mxfile><broken" readOnly={false} fileName="bad.drawio" onChange={() => {}} onInvalid={onInvalid} />);
    });
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  // F7: Escape in the middle of a move cancels it: the preview goes and the release commits nothing. With no gesture and no
  // selection the key is not used here, so a shell above can have it.
  it("Escape cancels a gesture under way, then clears the selection, then is left alone", async () => {
    const onChange = vi.fn();
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => { root!.render(<DrawioEditor text={SAMPLE} readOnly={false} fileName="a.drawio" onChange={onChange} />); });
    const shell = el.querySelector(".drawio-shell")!;
    const pointer = (target: EventTarget, type: string, x: number) => act(async () => {
      target.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: x, button: 0, bubbles: true, cancelable: true }), { pointerId: 1 }));
    });
    const escape = () => { const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); act(() => { shell.dispatchEvent(e); }); return e; };
    await pointer(el.querySelector("[data-drawio-cell='a']")!, "pointerdown", 10);
    await pointer(window, "pointermove", 80);
    expect(escape().defaultPrevented).toBe(true); // the gesture
    await pointer(window, "pointerup", 80);
    expect(onChange).not.toHaveBeenCalled();
    expect(el.querySelector(".drawio-node.on")).not.toBeNull(); // the selection is still there
    expect(escape().defaultPrevented).toBe(true); // the selection
    expect(el.querySelector(".drawio-node.on")).toBeNull();
    expect(escape().defaultPrevented).toBe(false); // nothing left: for the shell
  });
});
