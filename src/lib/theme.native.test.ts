// @vitest-environment jsdom
// The window's own title bar follows the app theme (DESK-9), and "Follow system" follows the Windows app mode (DESK-OS).
import { afterEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn(async (_theme: string | null) => {});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme }) }));

const { applyTheme, currentTheme, currentThemeChoice, followSystem, nativeTheme } = await import("./theme");
const { prefs } = await import("./prefs");
const g = window as unknown as { __TAURI_INTERNALS__?: unknown };
afterEach(() => { delete g.__TAURI_INTERNALS__; setTheme.mockClear(); vi.unstubAllGlobals(); applyTheme("purple", false); localStorage.clear(); });
/** The system's app mode, as prefers-color-scheme reports it. */
const systemMode = (mode: "light" | "dark") =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes(mode), addEventListener() {}, removeEventListener() {} }));

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

  it("following the system, shows the Emerald theme for its mode, tells the window nothing, and changes with the system", () => {
    g.__TAURI_INTERNALS__ = {};
    systemMode("light");
    applyTheme("system");
    expect([currentTheme(), currentThemeChoice(), document.documentElement.dataset.theme]).toEqual(["emerald-light", "system", "emerald-light"]);
    expect(setTheme).toHaveBeenLastCalledWith(null);
    expect(prefs.theme()).toBe("system");
    systemMode("dark");
    followSystem();
    expect(currentTheme()).toBe("emerald");
    // A theme picked by name stops following the system.
    applyTheme("purple", false);
    systemMode("light");
    followSystem();
    expect(currentTheme()).toBe("purple");
  });
});
