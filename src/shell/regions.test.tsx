// @vitest-environment jsdom
// F6 and Shift+F6 move the focus between the window's regions, and the skip link jumps to the content (DESK-A11Y A2). The real
// Shell on the Notes page with two panes and the context rail; only the editors and the graphs are stand-ins.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "notebooks_list" || cmd === "index_tags") return [];
    if (cmd === "lm") return { exit_code: 0, error: null, result: { domains: [], aliases: {}, global_domains: [], foreign_domains: [], notes: [] } };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {}, onCloseRequested: async () => () => {} }) }));
vi.mock("../features/review/useInboxItems", () => ({ useInboxItems: () => ({ total: 0 }) }));
vi.mock("../lib/connection", async (original) => ({ ...(await original<object>()), useSystemsEnabled: () => false, useProjectsEnabled: () => false }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => <p>Home page</p> }));
vi.mock("../features/agents/AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("../features/review/InboxPage", () => ({ InboxPage: () => null }));
vi.mock("../features/editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../features/editor/NewNote", () => ({ NewNote: () => null }));
// The first page has an editor, the others only text, so a pane's stop is the editor or else its panel.
vi.mock("../features/notes/FileTab", () => ({
  FileTab: ({ tab }: { tab: { id: string } }) => (tab.id === "c" ? <p>Reading</p> : <div className="cm-content" contentEditable tabIndex={0}>Editor</div>),
  saveFileTab: vi.fn(),
}));
vi.mock("../features/notes/NewFileTab", () => ({ NewFileTab: () => null }));
vi.mock("../features/links/LinksPanel", () => ({ LinksPanel: () => null, LocalGraphPanel: () => null }));
vi.mock("../features/graph/GraphView", () => ({ GraphView: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Shell } = await import("./Shell");
const { useShortcuts } = await import("../App");
const { useLayout } = await import("./layout");
const { useApp } = await import("../store");
const { useWorkspace } = await import("../workspace/store");
const { pushLayer } = await import("../ui/layers");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

const notebook = { id: "nb-1", path: "C:\\notes", title: "Notes", added: "" };
const entries = [{ path: "Inbox.md", kind: "page", size: 5, mtimeMs: 0 }, { path: "Plan.md", kind: "page", size: 5, mtimeMs: 0 }];
const page = (id: string, path: string) => ({ id, kind: "file" as const, file: { notebook: notebook.id, path }, mode: "live" as const });

function Host() { useShortcuts(); return null; }

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const press = async (key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods });
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(e); });
  return e;
};
const f6 = (back = false) => press("F6", { shiftKey: back });
/** Where the focus is, as a short name for the region. */
function where(): string {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return "body";
  if (a.closest("aside.sidebar")) return "sidebar";
  if (a.closest("header.topbar")) return "topbar";
  if (a.closest("nav.notebooks")) return "tree";
  if (a.closest("aside.note-rail")) return "rail";
  const pane = a.closest("section.pane");
  if (pane) return `${pane.getAttribute("aria-label")} ${a.getAttribute("role") === "tabpanel" ? "panel" : a.classList.contains("cm-content") ? "editor" : (a.getAttribute("role") ?? a.tagName)}`;
  if (a.closest("main.page-host")) return "page";
  return a.tagName;
}
async function walk(count: number, back = false): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) { await f6(back); seen.push(where()); }
  return seen;
}

async function show(panes: 1 | 2, notes = true) {
  useApp.setState({ route: { page: notes ? "notes" : "home" }, back: [] });
  useWorkspace.setState({
    panes: panes === 2
      ? [{ id: "p0", tabs: [page("a", "Inbox.md")], active: "a", size: 1 }, { id: "p1", tabs: [page("c", "Plan.md")], active: "c", size: 1 }]
      : [{ id: "p0", tabs: [page("a", "Inbox.md")], active: "a", size: 1 }],
    focused: "p0", rail: true, railSplit: true, railNarrow: false, dirty: {}, reveal: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebooks"], [notebook]);
  client.setQueryData(["notebook-tree", notebook.id], { entries, truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Host /><Shell info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await settle();
  (document.activeElement as HTMLElement | null)?.blur();
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1800, configurable: true });
  useLayout.setState({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null, focusMode: false });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  document.body.innerHTML = "";
});

describe("F6 and Shift+F6", () => {
  it("visit the sidebar, the top bar, the notes list, each pane and the rail, and wrap round", async () => {
    await show(2);
    const e = await f6();
    expect(e.defaultPrevented).toBe(true);
    expect(where()).toBe("sidebar");
    expect(document.activeElement?.textContent).toContain("Notes");
    expect((await walk(7)).join(" | ")).toBe("topbar | tree | Left pane editor | Right pane panel | rail | sidebar | topbar");
  });

  it("go back with Shift+F6, from the first region to the last and round again", async () => {
    await show(2);
    expect((await walk(7, true)).join(" | ")).toBe("rail | Right pane panel | Left pane editor | tree | topbar | sidebar | rail");
  });

  it("go to the first region from the page body, and from the skip link", async () => {
    await show(2);
    expect(where()).toBe("body");
    await f6();
    expect(where()).toBe("sidebar");
    document.querySelector<HTMLElement>(".skip-link")!.focus();
    await f6();
    expect(where()).toBe("sidebar");
  });

  it("go from a divider to the region after it, or the one before", async () => {
    await show(2);
    document.querySelector<HTMLElement>(".notes-page > .splitter")!.focus();
    await f6();
    expect(where()).toBe("Left pane editor");
    document.querySelector<HTMLElement>(".notes-page > .splitter")!.focus();
    await f6(true);
    expect(where()).toBe("tree");
  });

  it("go from inside a pane to the next region, whatever has the focus there", async () => {
    await show(2);
    document.querySelector<HTMLElement>("#pane-p0 [role=tab]")!.focus();
    await f6();
    expect(where()).toBe("Right pane panel");
    await f6(true);
    expect(where()).toBe("Left pane editor");
  });

  it("name a single pane Open notes and put three panes in order", async () => {
    await show(1);
    expect(document.querySelector("section.pane")?.getAttribute("aria-label")).toBe("Open notes");
    await f6();
    expect((await walk(4)).join(" | ")).toBe("topbar | tree | Open notes editor | rail");
  });

  it("skip a closed rail", async () => {
    await show(2);
    await act(async () => useWorkspace.getState().setRail(false));
    expect(document.querySelector("aside.note-rail")).toBeNull();
    expect((await walk(6)).join(" | ")).toBe("sidebar | topbar | tree | Left pane editor | Right pane panel | sidebar");
  });

  it("skip the sidebar, the top bar, the list and the rail in focus mode", async () => {
    await show(2);
    await act(async () => useLayout.getState().setFocusMode(true));
    expect((await walk(3)).join(" | ")).toBe("Left pane editor | Right pane panel | Left pane editor");
  });

  it("count the sidebar when it is collapsed to its icons", async () => {
    await show(2);
    await act(async () => useLayout.getState().setSidebarCollapsed(true));
    await f6();
    expect(where()).toBe("sidebar");
  });

  it("stand for the page where there are no panes", async () => {
    await show(2, false);
    expect((await walk(4)).join(" | ")).toBe("sidebar | topbar | page | sidebar");
  });

  it("do nothing under a dialog", async () => {
    await show(2);
    const dialog = pushLayer(() => {}, () => false, true);
    const e = await f6();
    expect(e.defaultPrevented).toBe(false);
    expect(where()).toBe("body");
    dialog.pop();
  });

  it("are remappable and show up in the registry", async () => {
    const { SHORTCUTS, shortcut, conflicts, setOverrides } = await import("../lib/shortcuts");
    expect(shortcut("region.next")).toMatchObject({ label: "Next region", group: "Navigation", default: "F6", remappable: true, scope: "app" });
    expect(shortcut("region.prev")).toMatchObject({ label: "Previous region", group: "Navigation", default: "Shift+F6", remappable: true });
    expect(SHORTCUTS.filter((s) => s.scope === "app" && s.default === "F6")).toHaveLength(1);
    expect(conflicts("F6", "tab.close").map((c) => c.with)).toEqual(["Next region"]);
    expect(conflicts("Shift+F6", "region.next").map((c) => c.with)).toEqual(["Previous region"]);
    await show(2);
    setOverrides({ "region.next": "Mod+Alt+J" });
    await f6();
    expect(where()).toBe("body");
    await press("j", { ctrlKey: true, altKey: true });
    expect(where()).toBe("sidebar");
    setOverrides({});
  });
});

describe("the skip link", () => {
  it("is the first control of the shell, named Skip to content", async () => {
    await show(2);
    const first = document.querySelector<HTMLElement>(".shell button, .shell a, .shell input");
    expect(first?.classList.contains("skip-link")).toBe(true);
    expect(first?.textContent).toBe("Skip to content");
  });

  it("moves the focus to the focused pane's tab panel on the Notes page", async () => {
    await show(2);
    await act(async () => useWorkspace.getState().focus("p1"));
    await act(async () => document.querySelector<HTMLButtonElement>(".skip-link")!.click());
    expect(document.activeElement).toBe(document.querySelector("#pane-p1 [role=tabpanel]"));
    await act(async () => useWorkspace.getState().focus("p0"));
    await act(async () => document.querySelector<HTMLButtonElement>(".skip-link")!.click());
    expect(document.activeElement).toBe(document.querySelector("#pane-p0 [role=tabpanel]"));
  });

  it("moves the focus to the page elsewhere", async () => {
    await show(1, false);
    await act(async () => document.querySelector<HTMLButtonElement>(".skip-link")!.click());
    expect(document.activeElement).toBe(document.querySelector("main.page-host"));
  });
});
