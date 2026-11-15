import { describe, expect, it } from "vitest";
import { keyAction, reloadKey, swallow, type Key } from "./keys";

const k = (key: string, o: Partial<Key> = {}): Key => ({ type: "keydown", key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });

describe("terminal keys", () => {
  it("routes the terminal's own keys", () => {
    expect(keyAction(k("c", { ctrlKey: true }), true)).toBe("copy");
    expect(keyAction(k("c", { ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(k("C", { ctrlKey: true, shiftKey: true }), false)).toBe("copy");
    expect(keyAction(k("v", { ctrlKey: true }), false)).toBe("paste");
    expect(keyAction(k("V", { ctrlKey: true, shiftKey: true }), false)).toBe("paste");
    expect(keyAction(k("K", { ctrlKey: true, shiftKey: true }), false)).toBe("leave");
    expect(keyAction(k("k", { ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(k("F", { ctrlKey: true, shiftKey: true }), false)).toBe("search");
    expect(keyAction(k("f", { ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(k("Enter", { shiftKey: true }), false)).toBe("newline");
    expect(keyAction(k("Enter"), false)).toBe("pass");
    expect(keyAction(k("Enter", { ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(k("Enter", { altKey: true, shiftKey: true }), false)).toBe("pass");
    expect(keyAction({ ...k("c", { ctrlKey: true }), type: "keyup" }, true)).toBe("pass");
  });

  it("swallows the app's shortcuts but not AltGr or paste", () => {
    for (const key of ["p", "o", "n", "g", "w", "k"]) expect(swallow(k(key, { ctrlKey: true }))).toBe(true);
    expect(swallow(k("A", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(swallow(k("F", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(swallow(k("p", { metaKey: true }))).toBe(true);
    expect(swallow(k("ArrowLeft", { altKey: true }))).toBe(true);
    expect(swallow(k("v", { ctrlKey: true }))).toBe(false);
    expect(swallow(k("q", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(swallow(k("a"))).toBe(false);
    expect(swallow(k("Enter"))).toBe(false);
    expect(swallow(k("F5"))).toBe(true);
    expect(swallow(k("r", { ctrlKey: true }))).toBe(true);
    expect(swallow(k("R", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(swallow(k("ArrowRight", { altKey: true }))).toBe(false);
  });
  it("recognises the reload keys only", () => {
    expect(reloadKey(k("F5"))).toBe(true);
    expect(reloadKey(k("F5", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(true);
    expect(reloadKey(k("r", { ctrlKey: true }))).toBe(true);
    expect(reloadKey(k("R", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(reloadKey(k("r", { metaKey: true }))).toBe(true);
    expect(reloadKey(k("r"))).toBe(false);
    expect(reloadKey(k("r", { ctrlKey: true, altKey: true }))).toBe(false);
    for (const key of ["a", "c", "v", "z", "x", "ArrowLeft", "F4"]) expect(reloadKey(k(key, { ctrlKey: true }))).toBe(false);
  });
});
