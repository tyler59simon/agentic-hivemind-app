// @vitest-environment jsdom
// Settings > Brand mounted over a fake Living Memory: the default row and one row per project, a name save, Use default, the
// error toast, and nothing drawn without the capability.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const { setTransport } = await import("../../lib/lm");
const { useConnection } = await import("../../lib/connection");
const { useToasts } = await import("../../ui/toast");
const { BrandSection } = await import("./BrandSection");

const project = (slug: string, name: string, brand?: object) => ({ slug, name, status: "active", repos: [], aliases: [], description: "", charter: null, created: "", updated: "", tag: `project/${slug}`, tag_registered: true, brand });
const reply = (result: unknown) => ({ exit_code: 0, result, error: null });

let asked: { argv: string[]; stdin: string | null }[] = [];
let defaultValue: object | null = { name: "Acme" };
let projectsReply: () => Promise<unknown> = async () => null;
function fakeLm() {
  asked = [];
  defaultValue = { name: "Acme" };
  projectsReply = async () => reply({ ok: true, projects: [project("core", "Core", { name: "Core Co", logo: "brand/project-core.logo" }), project("pay", "Pay")], warnings: [] });
  setTransport(async (_cmd, a) => {
    const argv = (a.argv ?? []) as string[];
    asked.push({ argv, stdin: (a.stdin as string | null) ?? null });
    switch (argv[0]) {
      case "config":
        if (argv[1] === "get") return reply({ ok: true, settings: { brand: { value: defaultValue, default: false } } });
        return reply({ ok: true, setting: "brand", value: null, operation_id: "op-1" });
      case "projects": return projectsReply();
      case "project": return reply({ ok: true, operation_id: "op-2" });
      default: return null;
    }
  });
}

let root: Root | null = null;
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BrandSection /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return el;
}
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); });
const rows = (el: Element) => [...el.querySelectorAll(".work-head")];
const button = (row: Element, label: string) => [...row.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));

beforeEach(() => {
  fakeLm();
  localStorage.clear();
  useToasts.setState({ items: [] });
  useConnection.setState({ commands: ["projects"], api: 2, capabilities: { brand: 1 } });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; setTransport(invoke as Parameters<typeof setTransport>[0]); });

describe("Settings > Brand", () => {
  it("draws nothing without the brand capability", async () => {
    useConnection.setState({ capabilities: {} });
    const el = await mount();
    expect(el.querySelector("section")).toBeNull();
  });

  it("has a default row and a row per project", async () => {
    const el = await mount();
    expect(el.querySelector("h2")!.textContent).toBe("Brand");
    expect(rows(el).map((r) => r.querySelector("b")!.textContent)).toEqual(["Default", "Core", "Pay"]);
    expect((el.querySelector("input[aria-label='Default brand name']") as HTMLInputElement).value).toBe("Acme");
    // Pay has no brand of its own, so its pages show the default name.
    expect((el.querySelector("input[aria-label='Pay brand name']") as HTMLInputElement).placeholder).toBe("Acme");
    expect(rows(el)[2].textContent).toContain("Living Memory emblem");
    expect(rows(el)[1].textContent).toContain("custom");
    expect(button(rows(el)[2], "Remove logo")).toBeUndefined();
  });

  it("saves an edited project name without touching its logo", async () => {
    const el = await mount();
    const input = el.querySelector("input[aria-label='Pay brand name']") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Pay Co");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise((r) => setTimeout(r, 20)); });
    const write = asked.find((a) => a.argv[0] === "project" && a.argv[1] === "update")!;
    expect(JSON.parse(write.stdin!)).toEqual({ slug: "pay", brand: { name: "Pay Co" } });
  });

  it("says a project without a logo uses the default logo when there is one", async () => {
    defaultValue = { name: "Acme", logo: "brand/default.logo" };
    const el = await mount();
    expect(rows(el)[2].textContent).toContain("the default logo");
    expect(rows(el)[1].textContent).toContain("custom");
  });

  it("keeps the buttons disabled until the saved name is read back", async () => {
    const el = await mount();
    let release!: () => void;
    const fresh = projectsReply;
    projectsReply = () => new Promise((r) => { release = () => r(fresh()); });
    const input = el.querySelector("input[aria-label='Core brand name']") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Core Two");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise((r) => setTimeout(r, 20)); });
    // The write landed but the refetch has not: Remove logo would send the old name.
    expect(asked.some((a) => a.argv[0] === "project")).toBe(true);
    expect(button(rows(el)[1], "Remove logo")!.disabled).toBe(true);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    expect(button(rows(el)[1], "Remove logo")!.disabled).toBe(false);
  });

  it("Use default removes the project's brand", async () => {
    const el = await mount();
    await click(button(rows(el)[1], "Use default")!);
    const write = asked.find((a) => a.argv[0] === "project" && a.argv[1] === "update")!;
    expect(JSON.parse(write.stdin!)).toEqual({ slug: "core", brand: null });
  });

  it("Clear removes the default brand", async () => {
    const el = await mount();
    await click(button(rows(el)[0], "Clear")!);
    expect(asked.find((a) => a.argv[0] === "config" && a.argv[1] === "set")!.argv[3]).toBe("null");
  });

  it("shows Living Memory's message when a logo is refused", async () => {
    const el = await mount();
    const refuse = vi.mocked(invoke).mockRejectedValueOnce("invalid_logo: the file is over 256 KB");
    await click(button(rows(el)[2], "Choose logo")!);
    expect(refuse).toHaveBeenCalledWith("brand_logo", { owner: "pay", name: "" });
    expect(useToasts.getState().items.some((t) => t.kind === "error" && t.text.includes("invalid_logo"))).toBe(true);
  });
});
