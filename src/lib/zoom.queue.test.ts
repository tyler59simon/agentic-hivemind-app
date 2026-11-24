// @vitest-environment jsdom
// Two quick zoom steps go two levels, even before the window reports the first (Codex review, DESK-R9).
import { afterEach, describe, expect, it, vi } from "vitest";

const asked: number[] = [];
const pending: (() => void)[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((_cmd: string, args: { zoom: number }) => {
    asked.push(args.zoom);
    return new Promise<number>((resolve) => pending.push(() => resolve(args.zoom)));
  }),
}));

const { currentZoom, zoomBy } = await import("./zoom");
const g = window as unknown as { __TAURI_INTERNALS__?: unknown };
afterEach(() => { delete g.__TAURI_INTERNALS__; });

describe("quick zoom steps", () => {
  it("build on the level last asked for", async () => {
    g.__TAURI_INTERNALS__ = {};
    const first = zoomBy("in");
    const second = zoomBy("in");
    expect(asked).toEqual([1.1, 1.25]);
    pending.forEach((done) => done());
    await Promise.all([first, second]);
    expect(currentZoom()).toBe(1.25);
    // Once both are answered, the next step starts from what the window has.
    const third = zoomBy("out");
    expect(asked[2]).toBe(1.1);
    pending[2]();
    await third;
  });
});
