import { describe, expect, it } from "vitest";
import { guardReload, reloadKey } from "./keys";

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
