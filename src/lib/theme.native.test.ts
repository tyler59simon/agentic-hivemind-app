// @vitest-environment jsdom
// The window's own title bar follows the app theme (DESK-9).
import { afterEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme }) }));

const { applyTheme, nativeTheme } = await import("./theme");
const g = window as unknown as { __TAURI_INTERNALS__?: unknown };
afterEach(() => { delete g.__TAURI_INTERNALS__; setTheme.mockClear(); });

describe("native title bar theme", () => {
  it("is light only for Emerald Light", () => {
    expect(nativeTheme("emerald-light")).toBe("light");
    expect(nativeTheme("emerald")).toBe("dark");
    expect(nativeTheme("purple")).toBe("dark");
  });

  it("is set with the theme inside the app, and never outside it", () => {
    applyTheme("emerald", false);
    expect(setTheme).not.toHaveBeenCalled();
    g.__TAURI_INTERNALS__ = {};
    applyTheme("emerald-light", false);
    expect(setTheme).toHaveBeenLastCalledWith("light");
    applyTheme("purple", false);
    expect(setTheme).toHaveBeenLastCalledWith("dark");
  });
});
