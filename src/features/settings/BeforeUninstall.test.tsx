// @vitest-environment jsdom
// REG-10: Settings > Before you uninstall lists the skill copies Hivemind published and removes the unedited ones.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows = [
  { name: "ingest", dir: "C:\Users\me\.claude\skills\ingest", state: "current", removable: true, reason: null },
  { name: "deploy", dir: "/home/me/.codex/skills/deploy", state: "edited", removable: false, reason: "Someone edited this copy; it stays." },
];
let report = { removed: ["C:\Users\me\.claude\skills\ingest"], kept: [rows[1]] };
const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "uninstall_skills") return rows;
  if (cmd === "uninstall_remove_skills") return report;
  if (cmd === "uninstall_inventory") return { trees: [], repos: [] };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { BeforeUninstall } = await import("./BeforeUninstall");

let root: Root | null = null;
async function mount() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><BeforeUninstall /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return el;
}
const button = (label: string) => { const all = [...document.querySelectorAll("button")].filter((b) => b.textContent === label); return all[all.length - 1] as HTMLButtonElement; };
const click = (label: string) => act(async () => { button(label).click(); await new Promise((r) => setTimeout(r, 10)); });

beforeEach(() => invoke.mockClear());
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("Before you uninstall: published skills", () => {
  it("lists the published copies with their state and the reason a copy stays", async () => {
    const el = await mount();
    expect(el.textContent).toContain("Published skills");
    expect(el.textContent).toContain("ingest");
    expect(el.textContent).toContain("Claude Code");
    expect(el.textContent).toContain("Current version");
    expect(el.textContent).toContain("deploy");
    expect(el.textContent).toContain("Edited outside Hivemind");
    expect(el.textContent).toContain("Someone edited this copy; it stays.");
    expect(el.textContent).not.toContain("published skills, and");
  });

  it("asks first, says what is removed and what stays, then removes and shows the report", async () => {
    const el = await mount();
    await click("Remove published skills");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "uninstall_remove_skills")).toBe(false);
    expect(document.body.textContent).toContain("nobody edited");
    expect(document.body.textContent).toContain("the skill library in Hivemind's app data");
    await click("Remove");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "uninstall_remove_skills")).toBe(true);
    expect(el.textContent).toContain("Removed 1 published skill copy.");
    expect(el.textContent).toContain("Kept:");
    expect(el.textContent).toContain("deploy");
  });

  it("says so when nothing is published", async () => {
    rows.length = 0;
    const el = await mount();
    expect(el.textContent).toContain("No skill copies published by Hivemind");
    expect(button("Remove published skills")).toBeUndefined();
    rows.push({ name: "x", dir: "d", state: "current", removable: true, reason: null });
  });
});
