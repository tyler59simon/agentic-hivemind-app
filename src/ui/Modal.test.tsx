// @vitest-environment jsdom
// A dialog is not a document: opened inside a white pane (or the sidebar) it is drawn in document.body, so it keeps the
// app theme. Its behaviour does not depend on where it is drawn.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Confirm, Modal } from "./Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let pane: HTMLElement;
async function mount(node: React.ReactNode) {
  pane = document.createElement("section");
  pane.setAttribute("data-paper", "");
  document.body.append(pane);
  root = createRoot(pane);
  await act(async () => root!.render(node));
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

describe("Modal", () => {
  it("opened inside a white pane is drawn outside it, in the body", async () => {
    await mount(<Modal title="Delete page" onClose={() => {}}><p>Sure?</p></Modal>);
    expect(dialog()).not.toBeNull();
    expect(pane.contains(dialog())).toBe(false);
    expect(dialog().closest("[data-paper]")).toBeNull();
    expect(dialog().closest(".overlay")!.parentElement).toBe(document.body);
  });

  it("closes on Escape and on the backdrop, and not while locked", async () => {
    const onClose = vi.fn();
    await mount(<Modal title="T" onClose={onClose}>x</Modal>);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { dialog().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1); // a click inside the dialog does not close it
    await act(async () => { dialog().closest(".overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => { dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(3);
    await act(async () => root!.render(<Modal title="T" onClose={onClose} locked>x</Modal>));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await act(async () => { dialog().closest(".overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.disabled).toBe(true);
  });

  it("is removed from the body when it closes", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? <Modal title="T" onClose={() => setOpen(false)}>x</Modal> : <p>closed</p>;
    }
    await mount(<Host />);
    expect(dialog()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Confirm focuses its action button and answers", async () => {
    const onAnswer = vi.fn();
    await mount(<Confirm title="Delete page" message="Sure?" action="Delete" danger onAnswer={onAnswer} />);
    expect(document.activeElement?.textContent).toBe("Delete");
    await act(async () => { (document.activeElement as HTMLElement).click(); });
    expect(onAnswer).toHaveBeenCalledWith(true);
  });
});
