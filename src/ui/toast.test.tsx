// @vitest-environment jsdom
// Toasts are read out once, wait while the pointer or focus is on them, and an Undo toast stays long enough to reach (DESK-7).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Announcer } from "./announce";
import { toast, toastMs, Toasts, useToasts } from "./toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
beforeEach(async () => {
  vi.useFakeTimers();
  useToasts.setState({ items: [] });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<><Toasts /><Announcer /></>));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); });

const shown = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent);
const said = (urgency: "polite" | "assertive") => document.querySelector(`[data-announce="${urgency}"]`)!.textContent;
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

describe("toasts", () => {
  it("go to the announcer, errors at once, and the visible list is not a live region", async () => {
    await act(async () => toast("Saved"));
    expect(said("polite")).toBe("Saved");
    await act(async () => toast("Could not save", "error"));
    expect(said("assertive")).toBe("Could not save");
    expect(document.querySelector(".toasts")!.getAttribute("aria-live")).toBeNull();
  });

  it("wait while the pointer is over them, then finish the time they had left", async () => {
    await act(async () => toast("Saved"));
    await wait(3000);
    const list = document.querySelector(".toasts")!;
    await act(async () => { list.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    await wait(20000);
    expect(shown()).toEqual(["Saved"]);
    await act(async () => { list.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    await wait(1900);
    expect(shown()).toEqual(["Saved"]);
    await wait(200);
    expect(shown()).toEqual([]);
  });

  it("with an action, stay at least 10 seconds, and 10 more after a pause", async () => {
    expect(toastMs({ kind: "info", action: { label: "Undo", run() {} } })).toBe(10000);
    expect(toastMs({ kind: "info" })).toBe(5000);
    await act(async () => toast("Archived", "info", { label: "Undo", run() {} }));
    await wait(9000);
    const button = document.querySelector<HTMLButtonElement>(".toast button")!;
    await act(async () => button.focus());
    await wait(30000);
    await act(async () => button.blur());
    await wait(9900);
    expect(shown()).toHaveLength(1);
    await wait(200);
    expect(shown()).toEqual([]);
  });
});
