// @vitest-environment jsdom
// NS-3D: Excalidraw is told where its fonts are before its code runs, and the code is loaded only when asked for.
import { afterEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ path: undefined as unknown, evaluated: 0 }));
vi.mock("@excalidraw/excalidraw", () => {
  // The library builds its font list when it is first evaluated, so the asset path must already be there.
  seen.path = (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH;
  seen.evaluated++;
  return { Excalidraw: () => null };
});
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

afterEach(() => { delete (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH; });

describe("loading Excalidraw", () => {
  it("does nothing until it is asked, then sets the asset path before the library is evaluated, once", async () => {
    const { loadExcalidraw, EXCALIDRAW_ASSETS } = await import("./excalidrawLoader");
    expect(seen.evaluated).toBe(0);
    expect((window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH).toBeUndefined();
    const first = loadExcalidraw();
    const second = loadExcalidraw();
    expect(second).toBe(first);
    await first;
    expect(EXCALIDRAW_ASSETS).toBe("/excalidraw-assets/");
    expect(seen.path).toBe("/excalidraw-assets/");
    expect(seen.evaluated).toBe(1);
  });
});
