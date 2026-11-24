// @vitest-environment jsdom
// CON-20: Settings > Schedules always lists the built-in schedules and offers the missing ones; other automations show only while
// "Show custom automations" is on, which is kept on this computer.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationView } from "../../lib/automations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auto = (id: string, name: string, action: Automation["action"], over: Partial<AutomationView> = {}): AutomationView => ({
  id, name, enabled: true, trigger: { kind: "daily", at: 120 }, action, project: null, repo: null, askFirst: false, notify: "failures",
  budgetUsd: 1, createdAt: 1, lastRun: null, nextDue: null, lastSeen: null, triggerText: "Daily at 02:00", ...over,
});
let saved: AutomationView[] = [];
const templates = [auto("nightly-maintenance", "Nightly memory maintenance", { kind: "memory_maintenance" }, { enabled: false }),
  auto("weekly-skill-upkeep", "Weekly skill upkeep", { kind: "skill_upkeep" }, { enabled: false })];
const invoke = vi.fn(async (cmd: string, args?: { automation?: Automation }) => {
  if (cmd === "automation_list") return { automations: saved, templates, runs: [] };
  if (cmd === "automation_put") {
    const a = { ...args!.automation!, id: args!.automation!.id || "new1", triggerText: "Daily at 02:00" } as AutomationView;
    saved = [...saved.filter((x) => x.id !== a.id), a];
    return a;
  }
  if (cmd === "get_settings") return { python: null, script: null, root: null };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { SchedulesSection } = await import("./SchedulesSection");
const { useCustomShown } = await import("./schedules");

let root: Root | null = null;
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SchedulesSection /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return el;
}
const names = (el: Element) => [...el.querySelectorAll(".schedule-row strong")].map((s) => s.textContent);
const checkbox = (el: Element, label: string) => [...el.querySelectorAll("label.check")].find((l) => l.textContent?.includes(label))!.querySelector("input")!;

beforeEach(() => {
  saved = [];
  invoke.mockClear();
  useCustomShown.setState({ shown: false });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Settings > Schedules", () => {
  it("offers the built-in schedules not made yet, and makes one already on from its switch", async () => {
    const el = await mount();
    expect(names(el)).toEqual(["Morning briefing", "Nightly memory maintenance"]);
    expect(el.textContent).toContain("Rebuild weekly in Notes, Wiki");
    await act(async () => { checkbox(el, "Nightly memory maintenance").click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const put = invoke.mock.calls.find(([cmd]) => cmd === "automation_put")![1]!.automation!;
    expect([put.id, put.enabled, put.action.kind]).toEqual(["", true, "memory_maintenance"]);
  });

  it("lists custom automations only while Show custom automations is on, and the built-in ones always", async () => {
    saved = [
      auto("b1", "Morning briefing", { kind: "executive_briefing", briefing: "priorities", days: 1 }),
      auto("w1", "Weekly wiki rebuild", { kind: "wiki_rebuild", domain: "demo" }, { project: "core" }),
      auto("c1", "Weekly code review", { kind: "role", role: "reviewer", engine: "claude", prompt: "p" }),
    ];
    const el = await mount();
    expect(names(el)).toEqual(["Morning briefing", "Weekly wiki rebuild", "Nightly memory maintenance"]);
    expect(checkbox(el, "Show custom automations").parentElement!.textContent).toContain("(1)");
    await act(async () => { checkbox(el, "Show custom automations").click(); });
    expect(names(el)).toContain("Weekly code review");
    expect(useCustomShown.getState().shown).toBe(true);
    // The template list offers only custom ones: the built-in maintenance template has its own row.
    const options = [...el.querySelectorAll("select[aria-label='Add a built-in automation'] option")].map((o) => o.textContent);
    expect(options.some((o) => o?.startsWith("Weekly skill upkeep"))).toBe(true);
    expect(options.some((o) => o?.startsWith("Nightly memory maintenance"))).toBe(false);
  });
});
