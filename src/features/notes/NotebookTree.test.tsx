// @vitest-environment jsdom
// NS-2C UI pass: a notebook with one waiting proposal announced "1 agent proposals". A folder notebook with page edits from
// agents says "N agent edits" and opens the Inbox (CON-9).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { NotebookTree } = await import("./NotebookTree");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function badge(proposals: number) {
  const lm = { domain: "demo", notebook: "plans", title: "Release plans", visibility: "searchable", private: false, revision: "r", pages: 1, assets: 0, asset_bytes: 0, proposals, updated: "" } as const;
  // As NotesPage's asNotebook shapes a Living Memory notebook for the tree.
  const notebook = { id: "lm:demo:plans", path: "demo · plans", title: lm.title, added: "" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", notebook.id], { entries: [], truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={notebook} lm={lm as never} onSettings={() => {}} onProposals={() => {}} /></QueryClientProvider>));
  return document.querySelector(".proposals-badge")?.getAttribute("aria-label");
}

describe("the proposals badge", () => {
  it("counts one proposal in the singular and more in the plural", async () => {
    expect(await badge(1)).toBe("1 agent proposal");
    await act(async () => root?.unmount());
    expect(await badge(3)).toBe("3 agent proposals");
  });
});

async function edits(count: number | undefined, onEdits = () => {}) {
  const notebook = { id: "nb-1", path: "C:\Users\me\Wiki", title: "Team wiki", added: "" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", notebook.id], { entries: [], truncated: false });
  client.setQueryData(["notebook-meta", notebook.id], {});
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={notebook} onSettings={() => {}} edits={count} onEdits={onEdits} /></QueryClientProvider>));
  return document.querySelector(".proposals-badge");
}

describe("the agent edits badge of a folder notebook", () => {
  it("says how many page edits wait, in the singular and the plural, and opens the Inbox", async () => {
    const opened = vi.fn();
    expect((await edits(1, opened))?.textContent).toBe("1 agent edit");
    await act(async () => (document.querySelector(".proposals-badge") as HTMLButtonElement).click());
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());
    expect((await edits(3))?.textContent).toBe("3 agent edits");
  });

  it("is absent when no edit waits", async () => {
    expect(await edits(0)).toBeNull();
    await act(async () => root?.unmount());
    expect(await edits(undefined)).toBeNull();
  });
});

