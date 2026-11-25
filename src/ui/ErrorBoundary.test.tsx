// @vitest-environment jsdom
// A render error below a boundary shows its message instead of blanking the window (DESK-1).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const core = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock("@tauri-apps/api/core", () => core);
const MARKER = "SECRET-MARKER-1";
/** The events sent to `log_client`. */
const sent = () => core.invoke.mock.calls.filter((c) => c[0] === "log_client").map((c) => (c[1] as { event: Record<string, unknown> }).event);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
let broken = true;
function Bomb() { if (broken) throw new Error("boom"); return <p>fine</p>; }

beforeEach(() => { core.invoke.mockReset(); core.invoke.mockImplementation(async () => undefined); (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; broken = true; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(async () => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("ErrorBoundary", () => {
  it("shows the error and runs onError once, while siblings keep rendering", async () => {
    const onError = vi.fn();
    await mount(<><ErrorBoundary label="This tab" onError={onError}><Bomb /></ErrorBoundary><p>sibling</p></>);
    expect(host.querySelector('[role="alert"] h2')!.textContent).toBe("This tab stopped working");
    expect(host.textContent).toContain("boom");
    expect(host.textContent).toContain("sibling");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("logs a render error as its name, source locations and component names, and none of its text", async () => {
    function Marked(): never { throw new Error(`${MARKER} in a page about private things`); }
    await mount(<ErrorBoundary label="This tab"><Marked /></ErrorBoundary>);
    const events = sent();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "render_error", name: "Error" });
    expect(events[0].component).toContain("Marked");
    expect(JSON.stringify(events)).not.toMatch(/SECRET-MARKER-1|private things|This tab/);
  });

  it("runs onError and shows the fallback whatever is thrown, and when logging fails", async () => {
    core.invoke.mockImplementation(() => { throw new Error("no ipc"); });
    const odd: [string, unknown, string][] = [
      ["null", null, "null"], ["undefined", undefined, "undefined"], ["false", false, "false"], ["a string", MARKER, MARKER],
      ["a symbol", Symbol("sym"), "Symbol(sym)"], ["an object without toString", Object.create(null), "An error that cannot be shown"],
      ["an object whose toString throws", { toString() { throw new Error("no"); } }, "An error that cannot be shown"],
    ];
    for (const [label, value, text] of odd) {
      const onError = vi.fn();
      function Throws(): never { throw value; }
      await mount(<ErrorBoundary label="This tab" onError={onError}><Throws /></ErrorBoundary>);
      expect(onError, label).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[role="alert"] h2')!.textContent, label).toBe("This tab stopped working");
      expect(host.querySelector(".error")!.textContent, label).toBe(text);
      // Copy details copies the same text.
      const writeText = vi.fn(async (_text: string) => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await act(async () => button("Copy details").click());
      expect(writeText.mock.calls[0][0], label).toContain(text);
      await act(async () => root?.unmount());
      root = null;
      host.remove();
    }
  });

  it("an onError that throws does not stop the log, and the log does not wait for it", async () => {
    await mount(<ErrorBoundary label="This tab" onError={() => { throw new Error("recovery failed"); }}><Bomb /></ErrorBoundary>);
    expect(sent()).toHaveLength(1);
  });

  it("Try again draws the children again", async () => {
    await mount(<ErrorBoundary label="This page"><Bomb /></ErrorBoundary>);
    broken = false;
    await act(async () => button("Try again").click());
    expect(host.textContent).toBe("fine");
  });

  it("a new resetKey clears the error", async () => {
    let show: (k: string) => void = () => {};
    function Host() {
      const [key, setKey] = useState("a");
      show = setKey;
      return <ErrorBoundary label="This tab" resetKey={key}><Bomb /></ErrorBoundary>;
    }
    await mount(<Host />);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    broken = false;
    await act(async () => show("b"));
    expect(host.textContent).toBe("fine");
  });

  it("a given retry replaces Try again, and Copy details copies the message", async () => {
    const run = vi.fn();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount(<ErrorBoundary label="Hivemind" retry={{ label: "Reload window", run }}><Bomb /></ErrorBoundary>);
    await act(async () => button("Reload window").click());
    expect(run).toHaveBeenCalled();
    await act(async () => button("Copy details").click());
    expect(writeText.mock.calls[0][0]).toContain("Error: boom");
    expect(button("Copied")).toBeTruthy();
  });
});
