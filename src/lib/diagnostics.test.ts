// @vitest-environment jsdom
// Copy diagnostics puts the text from Rust on the clipboard through copyLater (so the write stays inside the click on
// macOS) and says so; Open logs folder asks Rust to open it; Report a problem copies first, then asks Rust to open the issue page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const copyLater = vi.hoisted(() => vi.fn());
vi.mock("./platform", async (original) => ({ ...(await original<typeof import("./platform")>()), copyLater }));

const { copyDiagnostics, openLogsFolder, reportProblem } = await import("./diagnostics");
const { useToasts } = await import("../ui/toast");

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  invoke.mockReset();
  writeText.mockClear();
  copyLater.mockReset();
  // As copyLater does off macOS: wait for the text, then write it.
  copyLater.mockImplementation(async (_type: string, data: Promise<string>) => { await navigator.clipboard.writeText(await data); });
  useToasts.setState({ items: [] });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => useToasts.setState({ items: [] }));

const toasts = () => useToasts.getState().items.map((t) => [t.kind, t.text]);

describe("copyDiagnostics", () => {
  it("hands the pending text to copyLater at once, copies what Rust built and says so", async () => {
    let resolve: (text: string) => void = () => {};
    invoke.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const done = copyDiagnostics();
    // The write was started before the text was ready: that is what keeps it inside the click on macOS.
    expect(invoke).toHaveBeenCalledWith("diagnostics");
    expect(copyLater).toHaveBeenCalledTimes(1);
    expect(copyLater.mock.calls[0][0]).toBe("text/plain");
    expect(copyLater.mock.calls[0][1]).toBeInstanceOf(Promise);
    expect(writeText).not.toHaveBeenCalled();
    resolve("Hivemind 0.1.0\n");
    await done;
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

describe("reportProblem", () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    invoke.mockImplementation(async (cmd: string) => { order.push(`invoke ${cmd}`); return cmd === "diagnostics" ? "Hivemind 0.1.0\n" : undefined; });
    copyLater.mockImplementation(async (_type: string, data: Promise<string>) => { order.push("copy start"); await navigator.clipboard.writeText(await data); order.push("copy done"); });
  });

  it("copies the diagnostics first, then opens the issue page with nothing passed from here, and says to paste", async () => {
    await reportProblem();
    expect(order).toEqual(["invoke diagnostics", "copy start", "copy done", "invoke open_issue_page"]);
    expect(invoke).toHaveBeenLastCalledWith("open_issue_page");
    expect(writeText).toHaveBeenCalledWith("Hivemind 0.1.0\n");
    expect(toasts()).toEqual([["info", "Diagnostics copied. Paste them into the new issue."]]);
  });

  it("still opens the page when the copy fails, and says the copy failed", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    await reportProblem();
    expect(invoke).toHaveBeenCalledWith("open_issue_page");
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0][0]).toBe("error");
    expect(toasts()[0][1]).toContain("Could not copy diagnostics (denied)");
  });

  it("reports a page that does not open", async () => {
    invoke.mockImplementation(async (cmd: string) => { if (cmd === "open_issue_page") throw "no browser"; return "text"; });
    await reportProblem();
    expect(toasts()).toEqual([["error", "Diagnostics copied, but could not open the issue page: no browser"]]);
  });
});
