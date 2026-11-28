// @vitest-environment jsdom
// Notes > Wiki mounted for real over a fake Living Memory: the project list with its "Whole domain" row, a picked project's page,
// a project with no notes, the agent edition of a project with its weekly switch, and the Whole domain view with its picker.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiModel } from "../../lib/lm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "automation_list" ? { automations: [], templates: [], runs: [] } : null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

const { setTransport } = await import("../../lib/lm");
const { useConnection } = await import("../../lib/connection");
const { useApp } = await import("../../store");
const { WikiPane } = await import("./WikiPane");

const project = (slug: string, name: string, charter: string | null) => ({ slug, name, status: "active", repos: [], aliases: [], description: "", charter, created: "", updated: "", tag: `project/${slug}`, tag_registered: true });
const wikiProject = (slug: string, name: string, count: number) => ({ slug, name, description: "", aliases: [], repos: [], status: "active", charter: null, sections: {}, count, updated: "", briefs: [], maps: [] });
const model: WikiModel = { domain: "demo", generated: "2026-11-24", renderer: 1, archived: false, notes: [], projects: [wikiProject("core", "Core", 7)], folders: [], sections: [], external: {} };

let asked: string[][] = [];
const reply = (result: unknown) => ({ exit_code: 0, result, error: null });
function fakeLm() {
  asked = [];
  setTransport(async (_cmd, a) => {
    const argv = (a.argv ?? []) as string[];
    if (argv.length) asked.push(argv);
    switch (argv[0]) {
      case "domains": return reply({ ok: true, domains: [{ name: "demo", active: 7, kind: "memory" }, { name: "other", active: 1, kind: "memory" }], aliases: {}, global_domains: [], foreign_domains: [] });
      case "projects": return reply({ ok: true, projects: [project("core", "Core", "demo:aaaa"), project("pay", "Pay", "other:bbbb"), project("bare", "Bare", "demo:cccc")], warnings: [] });
      case "wiki":
        if (argv.includes("--agent")) return { exit_code: 1, result: null, error: { code: "invalid", message: "no agent wiki for demo yet" } };
        return reply({ ok: true, model: { ...model, domain: argv[argv.indexOf("--domain") + 1] } });
      default: return null; // get_settings: Claude Code is shown
    }
  });
}

let root: Root | null = null;
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WikiPane /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return el;
}
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 20)); });
const buttons = (el: Element) => [...el.querySelectorAll("button")];
const text = (el: Element) => el.textContent ?? "";

beforeEach(() => {
  fakeLm();
  useConnection.setState({ commands: ["wiki", "projects"], api: 2, capabilities: { wiki_agent: { version: 1 } } });
  useApp.setState({ project: null, domain: "demo", route: { page: "notes", view: "wiki" }, back: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; setTransport(invoke as Parameters<typeof setTransport>[0]); });

describe("Notes > Wiki", () => {
  it("with All projects picked, lists the projects after a Whole domain row, with counts where the domain is loaded", async () => {
    const el = await mount();
    const rows = [...el.querySelectorAll(".arrow-row")].map(text);
    expect(rows[0]).toContain("Whole domain (demo)");
    expect(rows[1]).toContain("Core");
    expect(rows[1]).toContain("7 notes"); // Core's domain is the loaded one, and the wiki has 7 notes for it
    expect(rows[2]).toContain("Pay");
    expect(rows[2]).not.toContain("note"); // another domain, not loaded
    expect(rows[3]).toContain("Bare");
    expect(rows[3]).toContain("0 notes");
    expect(el.querySelector(".wiki-bar")).toBeNull();
    // The list has no title of its own, so the pane has a hidden one (DESK-A11Y A2).
    expect([...el.querySelectorAll("h1")].map((h) => [h.textContent, h.className])).toEqual([["Wiki", "visually-hidden"]]);
  });

  it("a row picks the project in the sidebar and opens its wiki on its page", async () => {
    const el = await mount();
    await click(buttons(el).find((b) => text(b).includes("Core"))!);
    expect(useApp.getState().project).toBe("core");
    expect(useApp.getState().route).toEqual({ page: "notes", view: "wiki" });
    expect(text(el.querySelector(".wiki-bar")!)).toContain("Core");
    expect(text(el.querySelector("[aria-label='Wiki pages'] [aria-current=page]")!)).toContain("Core");
    // A wiki page's header is its h1, and the hidden one is not added to it.
    expect(el.querySelectorAll("h1").length).toBe(1);
    expect(el.querySelector("h1")!.classList.contains("visually-hidden")).toBe(false);
    expect(asked.some((a) => a[0] === "wiki" && a.includes("demo"))).toBe(true);
  });

  it("Whole domain opens the domain's wiki with its domain picker and both editions", async () => {
    const el = await mount();
    await click(buttons(el).find((b) => text(b).includes("Whole domain"))!);
    expect(useApp.getState().route).toEqual({ page: "notes", view: "wiki", domain: "demo", whole: true });
    expect(el.querySelector("select[aria-label=Domain]")).not.toBeNull();
    expect(buttons(el).map(text)).toEqual(expect.arrayContaining(["All projects", "Structured", "Agent-written"]));
    expect(text(el)).toContain("Demo wiki"); // the domain's main page
    // All projects goes back to the list.
    await click(buttons(el).find((b) => text(b) === "All projects")!);
    expect(useApp.getState().route).toEqual({ page: "notes", view: "wiki", domain: "demo" });
    expect(text(el)).toContain("Whole domain (demo)");
  });

  it("a project with no notes in its domain shows a plain empty state, not an error", async () => {
    useApp.setState({ project: "bare" });
    const el = await mount();
    expect(text(el)).toContain("No notes yet");
    expect(el.querySelectorAll("h1").length).toBe(1);
    expect(text(el)).toContain("project/bare");
    expect(el.querySelector(".error")).toBeNull();
    expect(el.querySelector(".wiki-layout")).toBeNull();
  });

  it("reads a project in its own domain, not the app's", async () => {
    useApp.setState({ project: "pay", domain: "demo" });
    await mount();
    expect(asked.some((a) => a[0] === "wiki" && a[a.indexOf("--domain") + 1] === "other")).toBe(true);
    expect(asked.some((a) => a[0] === "wiki" && a[a.indexOf("--domain") + 1] === "demo")).toBe(false);
  });

  it("a picked project's agent edition is the project's, with the weekly switch beside Export and no scope menu", async () => {
    useApp.setState({ project: "core", route: { page: "notes", view: "wiki", edition: "agent" } });
    const el = await mount();
    expect(asked.some((a) => a[0] === "wiki" && a.includes("--agent") && a[a.indexOf("--project") + 1] === "core")).toBe(true);
    expect(text(el)).toContain("No agent-written wiki yet");
    expect(text(el)).toContain("Rebuild weekly");
    expect(el.querySelector("select[aria-label=Scope]")).toBeNull();
    expect(el.querySelector("select[aria-label=Domain]")).toBeNull();
  });

  it("exports a picked project's structured wiki with its project only when Living Memory has brands", async () => {
    const exported = async (caps: object) => {
      vi.mocked(invoke).mockClear();
      useConnection.setState({ capabilities: caps });
      useApp.setState({ project: "core" });
      const el = await mount();
      await click(buttons(el).find((b) => text(b).includes("Export"))!);
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "wiki_export");
      titles.push(buttons(el).find((b) => text(b).includes("Export"))!.title);
      await act(async () => root?.unmount());
      root = null;
      document.body.innerHTML = "";
      return (call?.[1] as { project: string | null } | undefined)?.project;
    };
    const titles: string[] = [];
    expect(await exported({ wiki_agent: { version: 1 }, brand: 1 })).toBe("core");
    expect(await exported({ wiki_agent: { version: 1 } })).toBeNull();
    // The button names what the file holds: the project, or the whole domain.
    expect(titles[0]).not.toContain("demo");
    expect(titles[1]).toContain("demo");
  });
});
