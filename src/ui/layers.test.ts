// @vitest-environment jsdom
// Escape closes the top layer only (DESK-4).
import { describe, expect, it, vi } from "vitest";
import { anyLayer, isTopLayer, pushLayer } from "./layers";

const escape = () => { const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true }); window.dispatchEvent(e); return e; };

describe("layers", () => {
  it("closes the top layer, then the next, whatever order they are taken off in", () => {
    const a = vi.fn(), b = vi.fn();
    const first = pushLayer(a);
    const second = pushLayer(b);
    expect(isTopLayer(second.id)).toBe(true);
    expect(escape().defaultPrevented).toBe(true);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([0, 1]);
    second.pop();
    escape();
    expect(a).toHaveBeenCalledTimes(1);
    first.pop();
    expect(anyLayer()).toBe(false);
    expect(escape().defaultPrevented).toBe(false);
  });

  it("a locked layer keeps Escape from the ones under it, and a field that used Escape wins", () => {
    const under = vi.fn(), top = vi.fn();
    const u = pushLayer(under);
    const t = pushLayer(top, () => true);
    escape();
    expect([under.mock.calls.length, top.mock.calls.length]).toEqual([0, 0]);
    t.pop();
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    used.preventDefault();
    window.dispatchEvent(used);
    expect(under).not.toHaveBeenCalled();
    u.pop();
  });
});
