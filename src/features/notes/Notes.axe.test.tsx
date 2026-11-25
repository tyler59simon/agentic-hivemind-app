// @vitest-environment jsdom
// Accessibility of the Notes page (DESK-A11Y A1): the real Shell, Sidebar, Topbar, notes tree, two panes with tabs, and the
// context rail, checked with axe. Only what needs Tauri, WebGL or an editor is replaced. The baseline lists what axe reports
// today; a later stage removes an entry when it fixes the cause.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "notebooks_list" || cmd === "index_tags") return [];
    if (cmd === "lm") return { exit_code: 0, error: null, result: { domains: [], aliases: {}, global_domains: [], foreign_domains: [], notes: [] } };
    return null;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));
vi.mock("../review/useInboxItems", () => ({ useInboxItems: () => ({ total: 0 }) }));
vi.mock("../../lib/connection", async (original) => ({ ...(await original<object>()), useSystemsEnabled: () => false, useProjectsEnabled: () => false }));
vi.mock("../home/HomePage", () => ({ HomePage: () => null }));
vi.mock("../agents/AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("../review/InboxPage", () => ({ InboxPage: () => null }));
// The tab bodies are editors, and the graphs need WebGL; neither is what this test looks at.
vi.mock("../editor/NoteTab", () => ({ NoteTab: () => null }));
vi.mock("../editor/NewNote", () => ({ NewNote: () => null }));
vi.mock("./FileTab", () => ({ FileTab: () => <p>Page body</p>, saveFileTab: vi.fn() }));
vi.mock("./NewFileTab", () => ({ NewFileTab: () => null }));
vi.mock("../links/LinksPanel", () => ({ LinksPanel: () => null, LocalGraphPanel: () => null }));
vi.mock("../graph/GraphView", () => ({ GraphView: () => null }));
Element.prototype.scrollIntoView = () => {};

const { Shell } = await import("../../shell/Shell");
const { useLayout } = await import("../../shell/layout");
const { useApp } = await import("../../store");
const { useWorkspace } = await import("../../workspace/store");
const info = { user: "Ada", root: "/lm", script: "lm" } as never;

const notebook = { id: "nb-1", path: "C:\\notes", title: "Notes", added: "" };
const entries = [{ path: "Projects", kind: "dir", size: 0, mtimeMs: 0 }, { path: "Projects/Plan.md", kind: "page", size: 5, mtimeMs: 0 }, { path: "Inbox.md", kind: "page", size: 5, mtimeMs: 0 }];
const page = (id: string, path: string) => ({ id, kind: "file" as const, file: { notebook: notebook.id, path }, mode: "live" as const });

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1800, configurable: true });
  useLayout.setState({ sidebarWidth: 15.4, sidebarCollapsed: false, treeWidth: 16, railWidth: null, focusMode: false });
  useApp.setState({ route: { page: "notes" }, back: [] });
  useWorkspace.setState({
    panes: [{ id: "p0", tabs: [page("a", "Inbox.md"), page("b", "Projects/Plan.md")], active: "a", size: 1 }, { id: "p1", tabs: [page("c", "Projects/Plan.md")], active: "c", size: 1 }],
    focused: "p0", rail: true, railSplit: true, railNarrow: true, dirty: {}, reveal: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebooks"], [notebook]);
  client.setQueryData(["notebook-tree", notebook.id], { entries, truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Shell info={info} onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  document.body.innerHTML = "";
});

/** What axe reports on this page today. Each entry names its cause; remove the entry in the commit that fixes it. */
const BASELINE = [
  // The tree's expand button has an icon and no name (NotebookTree.tsx:284).
  'button-name @ button[aria-hidden="false"]',
  // The rail panels put an h4 under the Section h2 (ui/Page.tsx:55) and skip h3 (links/LinksPanel.tsx:36, RelatedPanel.tsx:32).
  "heading-order @ .section:nth-child(2) > .links-panel > .links-section:nth-child(1) > h4",
  "heading-order @ .section:nth-child(4) > .links-panel > .links-section:nth-child(1) > h4",
  // aria-label on a div without a role is not exposed (NotesPage.tsx:110).
  "review:aria-prohibited-attr @ .notes-views",
  // The account button is named "Account and settings" but shows the user's name (ui/Menu.tsx:28, Sidebar.tsx:96): WCAG 2.5.3.
  'review:label-content-name-mismatch @ button[aria-label="Account and settings"]',
];

describe("the Notes page: tree, two panes with tabs, and the context rail", () => {
  it("draws the tree, both panes and the rail", () => {
    expect(document.querySelectorAll("[role=treeitem]").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[role=tablist]").length).toBe(2);
    expect(document.querySelector("aside.note-rail")).not.toBeNull();
  });

  it("has only the violations recorded in the baseline", async () => {
    await expectNoNewAxeViolations(document.body, BASELINE);
  });
});
