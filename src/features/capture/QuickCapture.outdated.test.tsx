// @vitest-environment jsdom
// Codex review of e30902f, C1: the quick capture window applies the main window's Living Memory requirement to a memory
// capture. With an older Living Memory it says so and sends nothing; a page capture stays available.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: async () => {}, onFocusChanged: async () => () => {} }) }));

const lm = await import("../../lib/lm");
const { QuickCapture, OUTDATED, CHECKING, UNCHECKED } = await import("./QuickCapture");

const sent: string[][] = [];
let capabilities: Record<string, unknown> = {};
/** How `version` answers: as usual, never, or with an error. */
let versionAnswer: "ok" | "never" | "fail" = "ok";
lm.setTransport(async (_cmd, args) => {
  const argv = (args as { argv: string[] }).argv;
  sent.push(argv);
  if (argv[0] === "version" && versionAnswer === "never") return new Promise(() => {});
  if (argv[0] === "version" && versionAnswer === "fail") return { exit_code: 1, result: null, error: { code: "internal", message: "bridge down" } };
  if (argv[0] === "version") return { exit_code: 0, error: null, result: { api: 3, python: "3.12", commands: ["capture"], capabilities } };
  if (argv[0] === "capture") return { exit_code: 0, error: null, result: { ok: true, id: "n1", status: "created", domain: "work", operation_id: "c-1" } };
  return { exit_code: 1, result: null, error: { code: "invalid", message: "not in this test" } };
});

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const save = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save")!;

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["domains"], { domains: [{ name: "work", bound: true, active: 3 }], aliases: {}, global_domains: [], foreign_domains: [] });
  client.setQueryData(["taxonomy"], { tags: ["concern/knowledge"] });
  client.setQueryData(["projects"], { projects: [] });
  client.setQueryData(["notebooks"], []);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><QuickCapture /></QueryClientProvider>));
  await settle();
  await type(document.querySelector<HTMLInputElement>("input.title-input")!, "A fact");
  await type(document.querySelectorAll("textarea")[0], "One sentence.");
}

beforeEach(() => { localStorage.clear(); sent.length = 0; versionAnswer = "ok"; });
const ctrlEnter = () => act(async () => {
  document.querySelector("main.quick-capture")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("quick capture to memory", () => {
  it("refuses a Living Memory the main window would refuse, and sends nothing", async () => {
    capabilities = { direct_writes: 1, revisions: 0, proposals: 1 };
    await mount();
    expect(document.body.textContent).toContain(OUTDATED);
    expect(save().disabled).toBe(true);
    await act(async () => save().click());
    await settle();
    expect(sent.some((a) => a[0] === "capture")).toBe(false);
  });

  // Codex re-review, N08: no version answer yet, or a failed check, is not a pass.
  it("does not capture to memory before the version check passes", async () => {
    capabilities = { direct_writes: 2, revisions: 1, proposals: 1 };
    versionAnswer = "never";
    await mount();
    expect(document.body.textContent).toContain(CHECKING);
    expect(save().disabled).toBe(true);
    await ctrlEnter();
    await settle();
    expect(sent.some((a) => a[0] === "capture")).toBe(false);
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    versionAnswer = "fail";
    await mount();
    expect(document.body.textContent).toContain(UNCHECKED);
    expect(save().disabled).toBe(true);
    await ctrlEnter();
    await settle();
    expect(sent.some((a) => a[0] === "capture")).toBe(false);

    // A page capture does not need Living Memory.
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.includes("Today"))!.click());
    expect(document.body.textContent).not.toContain(UNCHECKED);
    expect(save().disabled).toBe(false);
  });

  it("captures while the computer is offline, since Living Memory is local", async () => {
    const { onlineManager } = await import("@tanstack/react-query");
    capabilities = { direct_writes: 2, revisions: 1, proposals: 1 };
    onlineManager.setOnline(false);
    try {
      await mount();
      await act(async () => save().click());
      await settle();
      expect(sent.some((a) => a[0] === "capture")).toBe(true);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("captures with a current Living Memory", async () => {
    capabilities = { direct_writes: 2, revisions: 1, proposals: 1 };
    await mount();
    expect(document.body.textContent).not.toContain(OUTDATED);
    await act(async () => save().click());
    await settle();
    expect(sent.some((a) => a[0] === "capture")).toBe(true);
  });
});
