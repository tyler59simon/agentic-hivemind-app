// @vitest-environment jsdom
// Copy diagnostics puts the text from Rust on the clipboard and says so; Open logs folder asks Rust to open it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { copyDiagnostics, openLogsFolder } = await import("./diagnostics");
const { useToasts } = await import("../ui/toast");

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  invoke.mockReset();
  writeText.mockClear();
  useToasts.setState({ items: [] });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => useToasts.setState({ items: [] }));

const toasts = () => useToasts.getState().items.map((t) => [t.kind, t.text]);

describe("copyDiagnostics", () => {
  it("copies what Rust built and says so", async () => {
    invoke.mockResolvedValue("Hivemind 0.1.0\n");
    await copyDiagnostics();
    expect(invoke).toHaveBeenCalledWith("diagnostics");
    expect(writeText).toHaveBeenCalledWith("Hivemind 0.1.0\n");
    expect(toasts()).toEqual([["info", "Diagnostics copied"]]);
  });

  it("shows an error toast when Rust fails or the clipboard refuses", async () => {
    invoke.mockRejectedValue("no log folder");
    await copyDiagnostics();
    expect(toasts()).toEqual([["error", "Could not copy diagnostics: no log folder"]]);
    useToasts.setState({ items: [] });
    invoke.mockResolvedValue("text");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await copyDiagnostics();
    expect(toasts()).toEqual([["error", "Could not copy diagnostics: denied"]]);
  });
});

describe("openLogsFolder", () => {
  it("asks Rust to open it, and reports a failure", async () => {
    invoke.mockResolvedValue(undefined);
    await openLogsFolder();
    expect(invoke).toHaveBeenCalledWith("open_logs_folder");
    expect(toasts()).toEqual([]);
    invoke.mockRejectedValue("no file manager");
    await openLogsFolder();
    expect(toasts()).toEqual([["error", "Could not open the logs folder: no file manager"]]);
  });
});
