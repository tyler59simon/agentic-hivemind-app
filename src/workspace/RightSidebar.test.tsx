// @vitest-environment jsdom
// NS-2C UI pass: the rail beside a Living Memory page named its notebook by container id (`lm:demo:plans`); it now
// names it as the tree does, domain and title.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// The note rail's graph needs WebGL, which jsdom does not have; the page rail never draws it.
vi.mock("../features/links/LinksPanel", () => ({ LinksPanel: () => null, LocalGraphPanel: () => null }));

const { PageRail } = await import("./RightSidebar");
const { useWorkspace } = await import("./store");
const { notebookTitle } = await import("../features/notes/notebookTitle");

const lmRow = { domain: "demo", notebook: "plans", title: "Release plans" } as never;
let root: Root | null = null;

beforeEach(() => {
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function rail(notebook: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["lm-notebooks"], { notebooks: [lmRow], damaged: [] });
  client.setQueryData(["notebooks"], [{ id: "nb-1", path: "C:\\nb", title: "Garden", added: "" }]);
  useWorkspace.getState().openTab({ kind: "file", file: { notebook, path: "Release 2.0.md" }, mode: "source" });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><PageRail /></QueryClientProvider>));
  const row = [...document.querySelectorAll("dl.properties > div")].find((d) => d.querySelector("dt")?.textContent === "Notebook");
  return row?.querySelector("dd")?.textContent;
}

describe("the notebook named beside a page", () => {
  it("a Living Memory page shows its domain and notebook title, not its container id", async () => {
    expect(await rail("lm:demo:plans")).toBe("demo · Release plans");
  });

  it("a folder notebook page shows the notebook's title", async () => {
    expect(await rail("nb-1")).toBe("Garden");
  });

  it("a Living Memory notebook missing from the list falls back to its name, still with its domain", () => {
    expect(notebookTitle("lm:jot:daily", [], [lmRow])).toBe("jot · daily");
    expect(notebookTitle("nb-2", [], [lmRow])).toBeUndefined();
  });
});

describe("the page outline (NS-3A UI pass)", () => {
  async function outlineOf(text: string) {
    const { PageOutline, OUTLINE_MAX } = await import("./RightSidebar");
    const { useDocuments, keyOf } = await import("../documents/store");
    const file = { notebook: "nb-1", path: "Long.md" };
    useWorkspace.getState().openTab({ kind: "file", file, mode: "live" });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    const set = (t: string) => useDocuments.setState((s) => ({ docs: { ...s.docs, [keyOf(file)]: { ...(s.docs[keyOf(file)] ?? {}), text: t } as never } }));
    set(text);
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<PageOutline tab={tab} />));
    return { el, set, OUTLINE_MAX };
  }

  it("lists at most OUTLINE_MAX headings and says how many more there are", async () => {
    const { OUTLINE_MAX } = await import("./RightSidebar");
    const { el } = await outlineOf(Array.from({ length: OUTLINE_MAX + 120 }, (_, i) => `## H${i}\n`).join("\n"));
    expect(el.querySelectorAll("li button").length).toBe(OUTLINE_MAX);
    expect(el.textContent).toContain("120 more headings");
  });

  it("follows a long page once typing pauses, and a short one at once", async () => {
    vi.useFakeTimers();
    try {
      const long = `# A\n${"x".repeat(150_000)}\n`;
      const { el, set } = await outlineOf(long);
      expect(el.textContent).toBe("A");
      await act(async () => set(`${long}# B\n`));
      expect(el.textContent).toBe("A");
      await act(async () => { vi.advanceTimersByTime(500); });
      expect(el.textContent).toBe("AB");
      await act(async () => set("# Short\n"));
      expect(el.textContent).toBe("Short");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the outline of a rich page (NS-3C UI-1)", () => {
  const heading = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
  const para = { type: "paragraph", content: [{ type: "text", text: "body" }] };
  const page = (...blocks: unknown[]) => JSON.stringify({ schemaVersion: 1, format: "hivemind-rich", meta: {}, content: { type: "doc", content: blocks } });

  async function outlineOf(text: string, path = "Plan.hmdoc") {
    const { PageOutline } = await import("./RightSidebar");
    const { useDocuments, keyOf } = await import("../documents/store");
    const file = { notebook: "nb-1", path };
    useWorkspace.getState().openTab({ kind: "file", file, mode: "source" });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    useDocuments.setState((s) => ({ docs: { ...s.docs, [keyOf(file)]: { text } as never } }));
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<PageOutline tab={tab} />));
    return { el, tab };
  }

  it("lists the headings of the page, at any depth and indented by level, and not the Markdown 'No headings.'", async () => {
    const columns = { type: "columns", content: [{ type: "column", content: [heading(2, "In a column")] }, { type: "column", content: [para] }] };
    const toggle = { type: "toggle", attrs: { open: true }, content: [{ type: "toggleSummary", content: [{ type: "text", text: "T" }] }, heading(3, "In a toggle")] };
    const { el } = await outlineOf(page(heading(1, "Title"), para, columns, toggle, heading(2, "Last")));
    expect([...el.querySelectorAll("li button")].map((b) => b.textContent)).toEqual(["Title", "In a column", "In a toggle", "Last"]);
    expect(el.textContent).not.toContain("No headings");
  });

  it("clicking a heading asks the rich editor for it by its order in the page", async () => {
    const { el, tab } = await outlineOf(page(heading(1, "One"), heading(2, "Two"), heading(2, "Three")));
    await act(async () => { (el.querySelectorAll("li button")[2] as HTMLElement).click(); });
    expect(useWorkspace.getState().reveal).toMatchObject({ tabId: tab.id, line: 2 });
  });

  it("a file that is not a page the editor opens has no headings", async () => {
    const { el } = await outlineOf("{ not json");
    expect(el.textContent).toContain("No headings.");
  });
});

describe("the Related section (NS-4B)", () => {
  const titles = () => [...document.querySelectorAll(".note-rail .section-head h2")].map((h) => h.textContent);

  it("is beside a folder notebook page, after its links", async () => {
    await rail("nb-1");
    expect(titles()).toEqual(["On this page", "Backlinks", "Outgoing links", "Related", "History", "File"]);
  });

  it("is not beside a Living Memory page, which the index does not hold", async () => {
    await rail("lm:demo:plans");
    expect(titles()).toEqual(["On this page", "History", "File"]);
  });

  it("is not beside a loose file", async () => {
    await rail("@abc123");
    expect(titles()).toEqual(["On this page", "History", "File"]);
  });
});
