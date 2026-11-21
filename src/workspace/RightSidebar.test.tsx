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
