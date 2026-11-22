// @vitest-environment jsdom
// NS-4A: the page rail's Backlinks and Outgoing links: only the links the resolver sends to the page count as backlinks,
// unlinked mentions are listed apart, a link to a page that is not there offers Create page and a picture is no link.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IncomingLink } from "../../lib/noteindex";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pages: Record<string, string[]> = { "nb-1": ["Plan.md", "Inbox.md", "Projects/Roadmap.md", "Archive/Plan.md"], "nb-2": ["Journal.md", "Plan.md"] };
const created: string[] = [];
const inLink = (notebook: string, path: string, raw: string, kind = "wiki", line = 1, context = raw): IncomingLink => ({ notebook, path, sha256: "h", raw, kind: kind as "wiki", embed: false, line, context });
const answers: Record<string, unknown> = {};
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Work", added: "" }];
      case "index_pages": return Object.entries(pages).flatMap(([notebook, list]) => list.map((path) => ({ notebook, path, kind: "md", title: path.replace(/\.md$/, "").split("/").pop(), mtimeMs: 1 })));
      case "index_links": return answers[`${a.notebook}:${a.path}`];
      case "notebook_tree": return { entries: pages[a.id as string].map((path) => ({ path, kind: "page" })), truncated: false };
      case "file_create": created.push(`${a.notebook}:${a.path}`); return { sha256: "s", size: 0, mtimeMs: 1 };
      case "lm": return { exit_code: 0, error: null, result: { notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Backlinks, OutgoingLinks, confirmBacklinks } = await import("./BacklinksPanel");
const { useWorkspace } = await import("../../workspace/store");

const file = { notebook: "nb-1", path: "Plan.md" };
const opened: { tab: Record<string, unknown>; split: boolean }[] = [];
let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>));
  await settle();
  return el;
}

beforeEach(() => {
  opened.length = 0; created.length = 0;
  useWorkspace.setState({ openTab: ((tab: Record<string, unknown>, opts?: { split?: boolean }) => { opened.push({ tab, split: !!opts?.split }); }) as never });
  answers["nb-1:Plan.md"] = {
    outgoing: [
      { raw: "Projects/Roadmap", kind: "wiki", embed: false, line: 2, context: "" },
      { raw: "Roadmap#Part", kind: "wiki", embed: false, line: 3, context: "" },
      { raw: "Not written yet", kind: "wiki", embed: false, line: 4, context: "" },
      { raw: "picture.png", kind: "wiki", embed: true, line: 5, context: "" },
      { raw: "Journal", kind: "wiki", embed: false, line: 6, context: "" },
      { raw: "Inbox.md", kind: "md", embed: false, line: 7, context: "" },
    ],
    incoming: [
      inLink("nb-1", "Inbox.md", "Plan", "wiki", 3, "Start with [[Plan]]"),
      inLink("nb-1", "Inbox.md", "Plan#Part", "wiki", 9, "see [[Plan#Part]]"),
      inLink("nb-1", "Projects/Roadmap.md", "../Plan.md", "md", 1, "the [plan](../Plan.md)"),
      // Journal is in another notebook that has its own Plan: its bare [[Plan]] is that one, not this.
      inLink("nb-2", "Journal.md", "Plan", "wiki", 1, "[[Plan]]"),
      inLink("nb-2", "Journal.md", "Main/Plan", "wiki", 2, "[[Main/Plan]]"),
      // Archive/Plan.md links its own Plan, which is the nearest one.
      inLink("nb-1", "Archive/Roadmap.md", "Plan", "wiki", 1, "x"),
    ],
    unlinked: [
      { notebook: "nb-1", path: "Inbox.md", title: "Inbox", snippet: "already linked" },
      { notebook: "nb-1", path: "Archive/Plan.md", title: "Plan", snippet: "the \u0001plan\u0002 for the quarter" },
    ],
  };
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("confirmBacklinks", () => {
  it("keeps the links the resolver sends to the page, grouped by the page that wrote them", () => {
    const env = { notebooks: [{ id: "nb-1", title: "Main" }, { id: "nb-2", title: "Work" }], pagesOf: (id: string) => pages[id], memory: [] };
    const rows = confirmBacklinks(file, (answers["nb-1:Plan.md"] as { incoming: IncomingLink[] }).incoming, env, new Map([["nb-1\nInbox.md", "Inbox"]]));
    expect(rows.map((r) => [r.notebook, r.path, r.title, r.lines.map((l) => l.line)])).toEqual([
      ["nb-1", "Inbox.md", "Inbox", [3, 9]],
      ["nb-1", "Projects/Roadmap.md", "Roadmap", [1]],
      ["nb-2", "Journal.md", "Journal", [2]],
    ]);
  });
});

describe("the rail's backlinks", () => {
  it("lists linked pages with their context, and unlinked mentions without the pages that link", async () => {
    const el = await mount(<Backlinks file={file} />);
    const sections = [...el.querySelectorAll("section")].map((s) => s.querySelector("h4")?.textContent);
    expect(sections).toEqual(["Linked 3", "Unlinked mentions 1"]);
    const linked = [...el.querySelectorAll("section")[0].querySelectorAll(".back-row")].map((r) => r.textContent);
    expect(linked[0]).toContain("Inbox");
    expect(linked[0]).toContain("Start with [[Plan]]");
    expect(el.querySelectorAll("section")[1].textContent).toContain("for the quarter");
    expect(el.querySelectorAll("section")[1].textContent).not.toContain("already linked");
    // A mark in a snippet is an element, never markup.
    expect(el.querySelector("section:nth-of-type(2) mark")?.textContent).toBe("plan");
    // A click opens the page, Ctrl+click beside.
    await act(async () => { el.querySelector<HTMLElement>(".back-row")!.click(); });
    expect(opened[0]).toMatchObject({ split: false, tab: { file: { notebook: "nb-1", path: "Inbox.md" } } });
  });
});

describe("the rail's outgoing links", () => {
  it("shows where each link points, a missing page with Create page, and leaves a picture out", async () => {
    const el = await mount(<OutgoingLinks file={file} />);
    const rows = [...el.querySelectorAll(".link-row")].map((r) => r.textContent);
    // [[Projects/Roadmap]] and [[Roadmap#Part]] are one page, so one row.
    expect(rows).toEqual(["Roadmap", "Not written yetCreate page", "Journal", "Inbox"]);
    await act(async () => { [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Create page")!.click(); });
    await settle();
    expect(created).toEqual(["nb-1:Not written yet.md"]);
    expect(opened[opened.length - 1]).toMatchObject({ split: true, tab: { file: { notebook: "nb-1", path: "Not written yet.md" } } });
  });

  it("says so when the page has no links", async () => {
    answers["nb-1:Plan.md"] = { outgoing: [], incoming: [], unlinked: [] };
    const el = await mount(<OutgoingLinks file={file} />);
    expect(el.textContent).toContain("This page has no links.");
  });
});
