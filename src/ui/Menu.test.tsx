// @vitest-environment jsdom
// Menus work from the keyboard (DESK-5).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";
import { Menu } from "./Menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
const key = async (k: string, init: KeyboardEventInit = {}) => {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
};
const focused = () => document.activeElement?.textContent;

describe("Menu", () => {
  it("focuses the first item, moves with arrows, Home, End and letters, and gives the focus back on Escape", async () => {
    const el = await mount(
      <Menu label="Actions" button="...">
        {(close) => ["Open", "Rename", "Delete"].map((t) => <li key={t} role="none"><button role="menuitem" onClick={close}>{t}</button></li>)}
      </Menu>,
    );
    const trigger = el.querySelector<HTMLButtonElement>(".menu-button")!;
    await act(async () => trigger.click());
    expect(focused()).toBe("Open");
    await key("ArrowDown");
    expect(focused()).toBe("Rename");
    await key("End");
    expect(focused()).toBe("Delete");
    await key("ArrowDown");
    expect(focused()).toBe("Open");
    await key("Home");
    expect(focused()).toBe("Open");
    await key("r");
    expect(focused()).toBe("Rename");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
    expect(el.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("runs an item's action after the focus is back on the button, so a dialog it opens returns there", async () => {
    let during: Element | null = null;
    const el = await mount(<Menu label="Actions" button="...">{(close) => <li role="none"><button role="menuitem" onClick={() => { close(); during = document.activeElement; }}>Go</button></li>}</Menu>);
    const trigger = el.querySelector<HTMLButtonElement>(".menu-button")!;
    await act(async () => trigger.click());
    await act(async () => (document.activeElement as HTMLElement).click());
    expect(during).toBe(trigger);
  });
});

describe("ContextMenu", () => {
  it("stays inside the window, takes the focus, and Tab gives it back to where it opened", async () => {
    Object.defineProperty(window, "innerWidth", { value: 300, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 200, configurable: true });
    const from = document.createElement("button");
    document.body.append(from);
    const onClose = vi.fn();
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { width: 120, height: 80, x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 80, toJSON() {} } as DOMRect;
    };
    try {
      await mount(
        <ContextMenu at={{ x: 290, y: 190 }} from={from} label="Row actions" onClose={onClose}>
          <li role="none"><button role="menuitem">Rename</button></li>
        </ContextMenu>,
      );
      const list = document.querySelector<HTMLElement>("[role=menu]")!;
      expect([list.style.left, list.style.top]).toEqual(["176px", "110px"]);
      expect(focused()).toBe("Rename");
      await key("Tab");
      expect(onClose).toHaveBeenCalled();
      expect(document.activeElement).toBe(from);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
  });
});
