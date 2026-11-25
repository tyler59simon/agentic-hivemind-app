// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { browserOnlyKey, guardBrowserKeys, guardReload, reloadKey } from "./keys";

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("reloadKey", () => {
  it("is F5, Ctrl+R and Ctrl+Shift+R, never AltGr+R", () => {
    expect(reloadKey(key("F5"))).toBe(true);
    expect(reloadKey(key("r", { ctrlKey: true }))).toBe(true);
    expect(reloadKey(key("R", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(reloadKey(key("r", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(reloadKey(key("r"))).toBe(false);
  });
});

describe("browserOnlyKey", () => {
  it("is Ctrl or Meta with P and nothing else, so editor keys such as Ctrl+U and Ctrl+Shift+P pass", () => {
    expect(browserOnlyKey(key("p", { ctrlKey: true }))).toBe(true);
    expect(browserOnlyKey(key("P", { ctrlKey: true }))).toBe(true);
    expect(browserOnlyKey(key("p", { metaKey: true }))).toBe(true);
    expect(browserOnlyKey(key("u", { ctrlKey: true }))).toBe(false);
    expect(browserOnlyKey(key("P", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(browserOnlyKey(key("p", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(browserOnlyKey(key("p"))).toBe(false);
    expect(browserOnlyKey(key("f", { ctrlKey: true }))).toBe(false);
  });
});

describe("guardBrowserKeys", () => {
  it("prevents the webview's print after every other listener, and leaves the key to anyone who handled it first", () => {
    const undo = guardBrowserKeys(window);
    const earlier: boolean[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    host.addEventListener("keydown", (e) => earlier.push(e.defaultPrevented));
    const print = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true, bubbles: true });
    host.dispatchEvent(print);
    expect(earlier).toEqual([false]);
    expect(print.defaultPrevented).toBe(true);
    const save = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true, bubbles: true });
    host.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(false);
    undo();
    const again = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true, bubbles: true });
    host.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
    host.remove();
  });
});

describe("guardReload", () => {
  function target() {
    let handler: ((e: KeyboardEvent) => void) | null = null;
    let capture = false;
    const t = {
      addEventListener: (_: string, h: (e: KeyboardEvent) => void, c: boolean) => { handler = h; capture = c; },
      removeEventListener: () => { handler = null; },
    } as unknown as Window;
    const press = (k: ReturnType<typeof key>) => { let stopped = false; handler?.({ ...k, preventDefault: () => { stopped = true; } } as unknown as KeyboardEvent); return stopped; };
    return { t, press, capture: () => capture, attached: () => handler !== null };
  }

  it("stops reload keys in the capture phase in a built app, and lets other keys through", () => {
    const { t, press, capture } = target();
    guardReload(t, false);
    expect(capture()).toBe(true);
    expect(press(key("F5"))).toBe(true);
    expect(press(key("r", { ctrlKey: true }))).toBe(true);
    expect(press(key("s", { ctrlKey: true }))).toBe(false);
  });

  it("keeps reload in development, and stops guarding when undone", () => {
    const dev = target();
    guardReload(dev.t, true);
    expect(dev.press(key("F5"))).toBe(false);
    const built = target();
    guardReload(built.t, false)();
    expect(built.attached()).toBe(false);
  });
});
