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

  it("names its close button Close in text, with the × hidden, so the name holds what is shown", async () => {
    await mount(<Modal title="Delete page" onClose={() => {}}><p>Sure?</p></Modal>);
    const close = dialog().querySelector<HTMLButtonElement>(".modal-head button")!;
    expect(close.hasAttribute("aria-label")).toBe(false);
    expect(close.querySelector("[aria-hidden]")!.textContent).toBe("×");
    expect(close.querySelector(".visually-hidden")!.textContent).toBe("Close");
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
    await act(async () => { dialog().querySelector<HTMLButtonElement>(".modal-head button")!.click(); });
    expect(onClose).toHaveBeenCalledTimes(3);
    await act(async () => root!.render(<Modal title="T" onClose={onClose} locked>x</Modal>));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await act(async () => { dialog().closest(".overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(dialog().querySelector<HTMLButtonElement>(".modal-head button")!.disabled).toBe(true);
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

  it("Confirm focuses Cancel when the action is dangerous, so a stray Enter does not confirm it (DESK-4)", async () => {
    const onAnswer = vi.fn();
    await mount(<Confirm title="Delete page" message="Sure?" action="Delete" danger onAnswer={onAnswer} />);
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => { (document.activeElement as HTMLElement).click(); });
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("a plain Confirm focuses its action button and answers yes", async () => {
    const onAnswer = vi.fn();
    await mount(<Confirm title="Open" message="Open it?" action="Open" onAnswer={onAnswer} />);
    expect(document.activeElement?.textContent).toBe("Open");
    await act(async () => { (document.activeElement as HTMLElement).click(); });
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("is modal: it takes the focus, Tab stays inside, and one Escape closes only the top dialog (DESK-4)", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Host() {
      const [more, setMore] = useState(false);
      return (
        <Modal title="Outer" onClose={outer}>
          <button id="more" onClick={() => setMore(true)}>More</button>
          {more && <Modal title="Inner" onClose={inner}><button>one</button><button>two</button></Modal>}
        </Modal>
      );
    }
    await mount(<Host />);
    await act(async () => document.getElementById("more")!.click());
    const top = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Inner"]')!;
    expect(top.getAttribute("aria-modal")).toBe("true");
    expect(top.contains(document.activeElement)).toBe(true);
    const buttons = [...top.querySelectorAll("button")];
    const last = buttons[buttons.length - 1];
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { last.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
    expect([inner.mock.calls.length, outer.mock.calls.length]).toEqual([1, 0]);
  });

  it("brings Tab back into the dialog when the focus fell to the page body (a button disabled during a write)", async () => {
    await mount(<><button id="behind">Behind</button><Modal title="Archive" onClose={() => {}} locked><button>Archive</button></Modal></>);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("gives the focus back to the button that opened it", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button id="opener" onClick={() => setOpen(true)}>Open</button>{open && <Modal title="T" onClose={() => setOpen(false)}><p>x</p></Modal>}</>;
    }
    await mount(<Host />);
    const opener = document.getElementById("opener")!;
    opener.focus();
    await act(async () => opener.click());
    expect(dialog().contains(document.activeElement)).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(opener);
  });
});
