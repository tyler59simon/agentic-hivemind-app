// @vitest-environment jsdom
// NS-4A: Ctrl+O lists the indexed pages of every notebook with their notebook as detail, and still lists them from the
// notebook trees when the index cannot answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let indexFails = false;
const page = (notebook: string, path: string, kind = "md") => ({ notebook, path, kind, title: path, mtimeMs: 1 });
// The graph's renderer needs WebGL, which jsdom lacks, and nothing here draws a graph.
vi.mock("sigma", () => ({ default: class {} }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }, { id: "nb-2", path: "C:\\two", title: "Work", added: "" }];
      case "index_pages": if (indexFails) throw new Error("The search index is not available"); return [page("nb-1", "Inbox.md"), page("nb-1", "Projects/Plan.hmdoc", "hmdoc"), page("nb-2", "Journal.md"), page("nb-2", "board.canvas", "canvas"), page("nb-9", "Gone.md")];
      case "notebook_tree": return { entries: args.id === "nb-1" ? [{ path: "Tree only.md", kind: "page" }, { path: "pic.png", kind: "other" }] : [], truncated: false };
      case "open_recent": return [];
      case "lm": return { exit_code: 0, error: null, result: { notes: [] } };
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Palette } = await import("./Palette");
const { useApp } = await import("../../store");

let root: Root | null = null;
const labels = () => [...document.querySelectorAll(".palette li button")].map((b) => [...b.querySelectorAll("span")].map((s) => s.textContent).join(" | "));
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Palette onSettings={() => {}} onReconnect={() => {}} /></QueryClientProvider>));
  await act(async () => useApp.getState().setPalette("notes"));
  await settle();
}

beforeEach(() => { indexFails = false; });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; useApp.getState().setPalette(null); });

describe("Ctrl+O", () => {
  it("lists every indexed page with its notebook and folder as the detail", async () => {
    await open();
    expect(labels()).toEqual([
      "Inbox | Main",
      "Plan | Main · Projects",
      "Journal | Work",
      "board.canvas | Work",
      "Open file from disk… | any file",
    ]);
    // The count sits in a status region that is in the dialog before the list changes, so a screen reader hears it (WCAG 4.1.3).
    expect(document.querySelector(".palette [role=status]")?.textContent).toBe("5 results");
  });

  it("lists the pages from the notebook trees while the index cannot answer", async () => {
    indexFails = true;
    await open();
    expect(labels()).toEqual(["Tree only | Main", "Open file from disk… | any file"]);
  });
});
