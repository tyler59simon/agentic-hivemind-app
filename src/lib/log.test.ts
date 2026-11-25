// @vitest-environment jsdom
// Webview logging: a no-op outside the Tauri app, and the window's uncaught errors and unhandled rejections reach the log.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ error: vi.fn(async (_m: string) => {}), warn: vi.fn(async (_m: string) => {}) }));
vi.mock("@tauri-apps/plugin-log", () => plugin);

const { cap, describeError, installGlobalLogging, logErrorLine, logWarnLine } = await import("./log");

const inApp = (on: boolean) => {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};
beforeEach(() => { plugin.error.mockClear(); plugin.warn.mockClear(); });
afterEach(() => inApp(false));

describe("log", () => {
  it("does nothing outside the Tauri app", () => {
    logErrorLine("x");
    logWarnLine("y");
    expect(plugin.error).not.toHaveBeenCalled();
    expect(plugin.warn).not.toHaveBeenCalled();
  });

  it("writes to the plugin inside the app, and never throws when it fails", async () => {
    inApp(true);
    logErrorLine("bad");
    logWarnLine("careful");
    expect(plugin.error).toHaveBeenCalledWith("bad");
    expect(plugin.warn).toHaveBeenCalledWith("careful");
    plugin.error.mockRejectedValueOnce(new Error("no ipc"));
    expect(() => logErrorLine("again")).not.toThrow();
    plugin.warn.mockImplementationOnce(() => { throw new Error("sync"); });
    expect(() => logWarnLine("again")).not.toThrow();
    await Promise.resolve();
  });

  it("cuts long text and describes an error with its stack", () => {
    expect(cap("abcdef", 3)).toBe("abc...");
    expect(cap("abc", 3)).toBe("abc");
    const e = new TypeError("nope");
    expect(describeError(e)).toContain("TypeError: nope");
    expect(describeError(e)).toContain(e.stack!);
    expect(describeError("x".repeat(400)).length).toBe(303);
  });

  it("logs an uncaught error with its place and stack, and an unhandled rejection", () => {
    inApp(true);
    installGlobalLogging();
    const error = new Error("boom");
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "app.js", lineno: 12, error }));
    const line = plugin.error.mock.calls[0][0];
    expect(line).toContain("Uncaught error: boom (app.js:12)");
    expect(line).toContain(error.stack!);
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: new Error("later") });
    window.dispatchEvent(rejection);
    expect(plugin.error.mock.calls[1][0]).toContain("Unhandled promise rejection: Error: later");
  });
});
