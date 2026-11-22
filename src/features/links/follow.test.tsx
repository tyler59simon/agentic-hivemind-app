// @vitest-environment jsdom
// NS-4A: following a link from a page: another notebook's page opens, a memory note opens, and a tie shows the picker
// whose pick is written into the page as the explicit form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pages: Record<string, string[]> = { "nb-1": ["Inbox.md", "Own.md"], "nb-2": ["Plan.md", "Solo.md"], "nb-3": ["Plan.md"] };
const files = new Map<string, string>();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Work", added: "" }, { id: "nb-3", path: "C:\\three", title: "Side", added: "" }];
      case "index_pages": return Object.entries(pages).flatMap(([notebook, list]) => list.map((path) => ({ notebook, path, kind: "md", title: path, mtimeMs: 1 })));
      case "file_read": return { text: files.get(a.path as string) ?? "", sha256: "sha", size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "draft_get": return null;
      case "lm": return { exit_code: 0, error: null, result: { notes: [{ ref: "demo:1", title: "Release checklist", domain: "demo", type: "knowledge" }] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useFollowLink } = await import("./follow");
const { useWorkspace } = await import("../../workspace/store");
const docs = await import("../../documents/store");
const { useApp } = await import("../../store");

const from = { notebook: "nb-1", path: "Inbox.md" };
const opened: { tab: Record<string, unknown>; split: boolean }[] = [];
let root: Root | null = null;
let go: (target: string, split?: boolean) => Promise<void> = async () => {};

function Harness() {
  const [dialog, ask] = useState<ReactNode>(null);
  const follow = useFollowLink(from, pages["nb-1"], ask);
  go = (target, split = false) => follow(target, split) as Promise<void>;
  return <>{dialog}</>;
}

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const text = () => docs.useDocuments.getState().docs[docs.keyOf(from)]?.text;
const choices = () => [...document.querySelectorAll<HTMLElement>("[role=dialog] li button")].map((b) => b.textContent);

beforeEach(async () => {
  opened.length = 0;
  files.set("Inbox.md", "Go to [[Plan]] and [[Plan#Part|the plan]], not [[Plan2]] or `[[Plan]]`.\n");
  useWorkspace.setState({
    panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {},
    openTab: ((tab: Record<string, unknown>, opts?: { split?: boolean }) => { opened.push({ tab, split: !!opts?.split }); }) as never,
    openNote: ((ref: string, opts?: { split?: boolean }) => { opened.push({ tab: { kind: "note", ref }, split: !!opts?.split }); }) as never,
  });
  useApp.setState({ domain: "other" });
  docs.useDocuments.setState({ docs: {}, refs: {}, held: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  // The page the link is followed from is open, as it is when a link is clicked in its tab.
  await act(async () => { await docs.open(from); });
  await settle();
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("following a link", () => {
  it("opens a page of another notebook when the page's own notebook has no such page", async () => {
    await act(async () => { await go("Solo"); });
    expect(opened).toEqual([{ tab: expect.objectContaining({ kind: "file", file: { notebook: "nb-2", path: "Solo.md" } }), split: false }]);
    await act(async () => { await go("Work/Plan", true); });
    expect(opened[1]).toMatchObject({ split: true, tab: { file: { notebook: "nb-2", path: "Plan.md" } } });
  });

  it("opens a memory note by its exact title, and sets its domain", async () => {
    await act(async () => { await go("release checklist"); });
    expect(opened).toEqual([{ tab: { kind: "note", ref: "demo:1" }, split: false }]);
    expect(useApp.getState().domain).toBe("demo");
  });

  it("a tie shows the picker; the pick opens the page and writes the explicit form where the link was followed from", async () => {
    await act(async () => { await go("Plan"); });
    await settle();
    expect(choices()).toEqual(["Work / Plan.md", "Side / Plan.md"]);
    expect(opened).toEqual([]);
    await act(async () => { (document.querySelectorAll<HTMLElement>("[role=dialog] li button")[1]).click(); });
    expect(opened).toEqual([{ tab: expect.objectContaining({ file: { notebook: "nb-3", path: "Plan.md" } }), split: false }]);
    // Every [[Plan]] of the page that named the page part, with headings and aliases kept, and not the code or other names.
    expect(text()).toBe("Go to [[Side/Plan]] and [[Side/Plan#Part|the plan]], not [[Plan2]] or `[[Plan]]`.\n");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("a missing page offers to create it, where a new page would go", async () => {
    await act(async () => { await go("Brand new"); });
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Create Brand new.md?");
    expect(opened).toEqual([]);
  });
});
