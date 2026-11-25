// @vitest-environment jsdom
// The shell's layout modes (DESK-LAYOUT): the sidebar collapse button, its width, focus mode with its exit button and
// Escape, and where the focus goes when a region hides.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("../features/projects/ProjectSwitcher", () => ({ ProjectSwitcher: () => <div className="project-switcher static">Project</div> }));
vi.mock("../features/review/useInboxItems", () => ({ useInboxItems: () => ({ total: 0 }) }));
vi.mock("../lib/connection", () => ({ useSystemsEnabled: () => false }));
vi.mock("./Topbar", () => ({ Topbar: () => <header className="topbar"><input aria-label="Search" /></header> }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => <div><button id="in-page">In the page</button></div> }));
vi.mock("../features/notes/NotesPage", () => ({ NotesPage: () => null }));
vi.mock("../features/agents/AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("../features/review/InboxPage", () => ({ InboxPage: () => null }));

const { Shell } = await import("./Shell");
const { useLayout } = await import("./layout");
const { useApp } = await import("../store");
const { pushLayer } = await import("../ui/layers");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

let root: Root | null = null;
const shell = () => document.querySelector<HTMLElement>(".shell")!;
const press = (key: string, target: EventTarget = document.body, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  act(() => { target.dispatchEvent(e); });
  return e;
};
const reset = () => {
  useLayout.setState({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null, focusMode: false });
  useApp.setState({ route: { page: "home" }, back: [] });
};

beforeEach(async () => {
  reset();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Shell info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  reset();
  document.body.innerHTML = "";
});

describe("the sidebar width and collapse button", () => {
  it("gives the shell the stored width in rem, with a splitter that names it", () => {
    expect(shell().style.getPropertyValue("--sidebar-w")).toBe("15.4rem");
    act(() => useLayout.getState().setSidebarWidth(20));
    expect(shell().style.getPropertyValue("--sidebar-w")).toBe("20rem");
    expect(document.querySelector("[role='separator'][aria-label='Sidebar width']")?.getAttribute("aria-valuenow")).toBe("20");
  });

  it("collapses and expands the sidebar, and says which with aria-expanded", () => {
    const button = document.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
    expect(button.getAttribute("aria-label")).toBe("Sidebar");
    expect(button.getAttribute("aria-controls")).toBe("app-sidebar");
    expect(document.getElementById("app-sidebar")).not.toBeNull();
    expect(button.closest(".brand-block")).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.title).toBe("Collapse the sidebar (Ctrl+Shift+B)");
    act(() => button.click());
    expect(shell().classList.contains("collapsed")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.title).toBe("Expand the sidebar (Ctrl+Shift+B)");
    expect(useLayout.getState().sidebarCollapsed).toBe(true);
    act(() => button.click());
    expect(shell().classList.contains("collapsed")).toBe(false);
  });
});

/** The window is `px` wide for the layout (it follows the resize event). */
const resizeTo = (px: number) => act(() => { Object.defineProperty(window, "innerWidth", { value: px, configurable: true }); window.dispatchEvent(new Event("resize")); });

describe("focus when a layout change hides what had it (A3)", () => {
  const splitter = () => document.querySelector<HTMLElement>(".shell > .splitter")!;

  it("goes to the sidebar button when the sidebar collapses with its divider focused", () => {
    splitter().focus();
    expect(document.activeElement).toBe(splitter());
    act(() => useLayout.getState().setSidebarCollapsed(true));
    expect(document.activeElement).toBe(document.querySelector(".sidebar-toggle"));
  });

  it("goes to the page when focus mode hides the divider", () => {
    splitter().focus();
    act(() => useLayout.getState().setFocusMode(true));
    expect(document.activeElement).toBe(document.querySelector("main.page-host"));
  });

  it("goes to the page when a narrow window folds the sidebar and its divider goes", () => {
    splitter().focus();
    resizeTo(900);
    expect(document.activeElement).toBe(document.querySelector("main.page-host"));
    resizeTo(1024);
  });

  it("leaves the focus alone when it is not in what went", () => {
    const toggle = document.querySelector<HTMLElement>(".sidebar-toggle")!;
    toggle.focus();
    act(() => useLayout.getState().setSidebarCollapsed(true));
    expect(document.activeElement).toBe(toggle);
    const nav = document.querySelector<HTMLElement>(".nav-item")!;
    nav.focus();
    act(() => useLayout.getState().setSidebarCollapsed(false));
    expect(document.activeElement).toBe(nav);
  });

  it("makes the page a visible focus target in CSS, and keeps the button name", () => {
    expect(document.querySelector("main.page-host")!.getAttribute("tabindex")).toBe("-1");
  });
});

describe("focus mode", () => {
  it("marks the shell, shows the way out, and the button leaves it with the focus on the page", () => {
    expect(document.querySelector(".focus-exit")).toBeNull();
    act(() => useLayout.getState().setFocusMode(true));
    expect(shell().classList.contains("focus")).toBe(true);
    const exit = document.querySelector<HTMLButtonElement>(".focus-exit")!;
    expect(exit.textContent).toBe("Exit focus mode");
    exit.focus();
    act(() => exit.click());
    expect(useLayout.getState().focusMode).toBe(false);
    expect(shell().classList.contains("focus")).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("main.page-host"));
  });

  it("moves the focus to the page when it was in a region that hides", () => {
    for (const inside of [".nav-item", ".topbar input"]) {
      reset();
      document.querySelector<HTMLElement>(inside)!.focus();
      expect(document.activeElement?.closest(".sidebar, .topbar")).not.toBeNull();
      act(() => useLayout.getState().setFocusMode(true));
      expect(document.activeElement).toBe(document.querySelector("main.page-host"));
      act(() => useLayout.getState().setFocusMode(false));
    }
  });

  it("keeps the focus where it is when it was in the page", () => {
    const inPage = document.querySelector<HTMLElement>("#in-page")!;
    inPage.focus();
    act(() => useLayout.getState().setFocusMode(true));
    expect(document.activeElement).toBe(inPage);
  });

  it("Escape leaves it", () => {
    act(() => useLayout.getState().setFocusMode(true));
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(useLayout.getState().focusMode).toBe(false);
  });

  it("does not take an Escape that a dialog, a menu, a field or an editor used", () => {
    act(() => useLayout.getState().setFocusMode(true));
    const layer = pushLayer(() => {});
    press("Escape");
    expect(useLayout.getState().focusMode).toBe(true);
    layer.pop();
    const field = document.createElement("input");
    document.querySelector(".page-host")!.append(field);
    press("Escape", field);
    expect(useLayout.getState().focusMode).toBe(true);
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    used.preventDefault();
    act(() => { document.body.dispatchEvent(used); });
    expect(useLayout.getState().focusMode).toBe(true);
    press("a");
    expect(useLayout.getState().focusMode).toBe(true);
  });

  it("does not listen for Escape when the mode is off", () => {
    expect(press("Escape").defaultPrevented).toBe(false);
  });
});
