// @vitest-environment jsdom
// The Rebuild weekly switch: the first time it goes on it makes the Sunday 03:00 automation ($2 a run, failures notified); after
// that it flips `enabled` on the same automation, and another project's rebuild is left alone.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation } from "../../lib/automations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let saved: Automation[] = [];
const invoke = vi.fn(async (cmd: string, args?: { automation?: Automation }) => {
  if (cmd === "automation_list") return { automations: saved, templates: [], runs: [] };
  if (cmd === "automation_put") {
    const a = { ...args!.automation!, id: args!.automation!.id || "a1" };
    saved = [...saved.filter((x) => x.id !== a.id), a];
    return a;
  }
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { WeeklyRebuildToggle, WEEKLY_REBUILD } = await import("./WeeklyRebuildToggle");

const rebuild = (project: string, over: Partial<Automation> = {}): Automation => ({
  id: `id-${project}`, name: WEEKLY_REBUILD, enabled: true, trigger: { kind: "weekly", days: [6], at: 180 }, action: { kind: "wiki_rebuild", domain: "demo" },
  project, repo: null, askFirst: false, notify: "failures", budgetUsd: 2, createdAt: 1, lastRun: null, nextDue: null, lastSeen: null, ...over,
});

let root: Root | null = null;
async function mount(project = "core") {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WeeklyRebuildToggle domain="demo" project={project} /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return el;
}
const box = (el: Element) => el.querySelector<HTMLInputElement>("input[type=checkbox]")!;
const flip = (el: Element) => act(async () => { box(el).click(); await new Promise((r) => setTimeout(r, 10)); });
const puts = () => invoke.mock.calls.filter(([cmd]) => cmd === "automation_put").map(([, args]) => args!.automation!);

beforeEach(() => { saved = []; invoke.mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Rebuild weekly switch", () => {
  it("starts off, and the first time it goes on it makes the weekly automation", async () => {
    const el = await mount();
    expect(box(el).checked).toBe(false);
    await flip(el);
    expect(puts()).toEqual([{
      id: "", name: "Weekly wiki rebuild", enabled: true, trigger: { kind: "weekly", days: [6], at: 180 }, action: { kind: "wiki_rebuild", domain: "demo" },
      project: "core", repo: null, askFirst: false, notify: "failures", budgetUsd: 2, createdAt: 0, lastRun: null, nextDue: null, lastSeen: null,
    }]);
    expect(box(el).checked).toBe(true);
  });

  it("then flips enabled on the same automation, keeping its schedule and cap", async () => {
    saved = [rebuild("core", { budgetUsd: 1.5, trigger: { kind: "weekly", days: [5], at: 240 } })];
    const el = await mount();
    expect(box(el).checked).toBe(true);
    await flip(el);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ id: "id-core", enabled: false, budgetUsd: 1.5, trigger: { days: [5], at: 240 }, action: { kind: "wiki_rebuild", domain: "demo" } });
    expect(box(el).checked).toBe(false);
    await flip(el);
    expect(puts()[1]).toMatchObject({ id: "id-core", enabled: true });
  });

  // Codex re-review of 55cfab2: renamed in Settings, Schedules, the rebuild is still this switch's, so no second one is made.
  it("still finds the rebuild after it was renamed", async () => {
    saved = [rebuild("core", { name: "Sunday rebuild" })];
    const el = await mount();
    expect(box(el).checked).toBe(true);
    await flip(el);
    expect(puts()).toEqual([expect.objectContaining({ id: "id-core", name: "Sunday rebuild", enabled: false })]);
  });

  it("finds the project's own rebuild, and says its cap and when it last ran", async () => {
    saved = [rebuild("pay", { enabled: true }), rebuild("core", { enabled: false, lastRun: Date.UTC(2026, 10, 22, 3, 0) })];
    const el = await mount("core");
    expect(box(el).checked).toBe(false);
    expect(el.textContent).toContain("up to $2.00 a run");
    expect(el.textContent).toContain("last ran");
    const other = document.createElement("div");
    document.body.append(other);
    const second = createRoot(other);
    await act(async () => second.render(<QueryClientProvider client={new QueryClient()}><WeeklyRebuildToggle domain="demo" project="pay" /></QueryClientProvider>));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(other.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect(other.textContent).not.toContain("last ran");
    await act(async () => second.unmount());
  });
});
