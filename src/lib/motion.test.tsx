// @vitest-environment jsdom
// Reduced motion (DESK-OS, DESK-A11Y A4): the scroll behaviour and the hook follow the system setting.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, scrollBehavior, useReducedMotion } from "./motion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A matchMedia that answers the reduced-motion query and lets a test change the answer. */
function mockMotion(initial: boolean) {
  let reduced = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === "(prefers-reduced-motion: reduce)" && reduced; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return { set(next: boolean) { reduced = next; listeners.forEach((fn) => fn()); }, listeners };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("scrollBehavior", () => {
  it("is smooth unless the system asked for less motion, and is asked each time", () => {
    const motion = mockMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
    motion.set(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("is smooth where matchMedia does not exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(scrollBehavior()).toBe("smooth");
  });
});

describe("useReducedMotion", () => {
  it("re-renders with the new answer when the setting changes, and lets go of the listener on unmount", async () => {
    const motion = mockMotion(false);
    const seen: boolean[] = [];
    function Probe() { const r = useReducedMotion(); seen.push(r); return null; }
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(<Probe />));
    expect(seen[seen.length - 1]).toBe(false);
    expect(motion.listeners.size).toBe(1);
    await act(async () => motion.set(true));
    expect(seen[seen.length - 1]).toBe(true);
    await act(async () => root.unmount());
    expect(motion.listeners.size).toBe(0);
  });
});
