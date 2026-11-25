// @vitest-environment jsdom
// A render error below a boundary shows its message instead of blanking the window (DESK-1).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const logged = vi.hoisted(() => vi.fn());
vi.mock("../lib/log", async (original) => ({ ...(await original<typeof import("../lib/log")>()), logErrorLine: logged }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
let broken = true;
function Bomb() { if (broken) throw new Error("boom"); return <p>fine</p>; }

beforeEach(() => { logged.mockClear(); broken = true; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

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

  it("logs the error with its name, message, stack and component stack", async () => {
    await mount(<ErrorBoundary label="This tab"><Bomb /></ErrorBoundary>);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = logged.mock.calls[0][0] as string;
    expect(line).toContain("This tab stopped: Error: boom");
    expect(line).toContain("at Bomb");
    expect(line).toContain("Component stack:");
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
