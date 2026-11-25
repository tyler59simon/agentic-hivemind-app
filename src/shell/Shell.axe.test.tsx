// @vitest-environment jsdom
// Accessibility of the whole frame (DESK-A11Y A1): the real Sidebar and Topbar around a stand-in page, checked with axe. The
// baseline lists what axe reports today; a later stage removes an entry when it fixes the cause.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "notebooks_list" || cmd === "index_tags") return [];
    if (cmd === "lm") return { exit_code: 0, error: null, result: { domains: [], aliases: {}, global_domains: [], foreign_domains: [], notes: [] } };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));
vi.mock("../features/review/useInboxItems", () => ({ useInboxItems: () => ({ total: 2 }) }));
vi.mock("../lib/connection", async (original) => ({ ...(await original<object>()), useSystemsEnabled: () => false, useProjectsEnabled: () => false }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => <div><h1>Home</h1><button type="button">In the page</button></div> }));
vi.mock("../features/notes/NotesPage", () => ({ NotesPage: () => null }));
vi.mock("../features/agents/AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("../features/review/InboxPage", () => ({ InboxPage: () => null }));

const { Shell } = await import("./Shell");
const { useLayout } = await import("./layout");
const { useApp } = await import("../store");
const { useWorkspace } = await import("../workspace/store");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  useLayout.setState({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null, focusMode: false });
  useApp.setState({ route: { page: "home" }, back: [] });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Shell info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** What axe reports on this page today: nothing. */
const BASELINE: string[] = [];

describe("the shell frame with the real Sidebar and Topbar", () => {
  it("draws the sidebar, the top bar and the page", () => {
    expect(document.querySelector("aside.sidebar nav.nav")).not.toBeNull();
    expect(document.querySelector("header.topbar input[role=combobox]")).not.toBeNull();
    expect(document.querySelector("main.page-host h1")).not.toBeNull();
    expect(document.querySelector(".nav-count")).not.toBeNull();
  });

  it("names the sections with their state in words, the account button by the user's name, and the sidebar as a landmark", () => {
    const text = (label: string) => [...document.querySelectorAll<HTMLElement>(".nav-item")].find((b) => b.title === label)!.textContent;
    expect(text("Inbox")).toBe("Inbox2, 2 waiting for you");
    expect(document.querySelector(".nav-count")!.getAttribute("aria-hidden")).toBe("true");
    const account = document.querySelector<HTMLElement>(".user-menu .menu-button")!;
    expect(account.hasAttribute("aria-label")).toBe(false);
    expect(account.textContent).toContain("Ada");
    expect(account.textContent).toContain(", account and settings");
    expect(document.querySelector("aside.sidebar")!.getAttribute("aria-label")).toBe("Sidebar");
  });

  it("has only the violations recorded in the baseline", async () => {
    await expectNoNewAxeViolations(document.body, BASELINE);
  });

  it("has the same ones with the unsaved-edits dot on the Notes section", async () => {
    await act(async () => useWorkspace.setState({ panes: [{ id: "p0", tabs: [{ id: "a", kind: "file", file: { notebook: "nb", path: "A.md" }, mode: "live" }], active: "a" }], dirty: { a: true } }));
    expect(document.querySelector(".nav-dot")).not.toBeNull();
    expect([...document.querySelectorAll<HTMLElement>(".nav-item")].find((b) => b.title === "Notes")!.textContent).toBe("Notes, A document has unsaved edits");
    await expectNoNewAxeViolations(document.body, BASELINE);
    await act(async () => useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], dirty: {} }));
  });

  it("has the same ones with the sidebar collapsed", async () => {
    await act(async () => useLayout.getState().setSidebarCollapsed(true));
    await expectNoNewAxeViolations(document.body, BASELINE);
  });
});
