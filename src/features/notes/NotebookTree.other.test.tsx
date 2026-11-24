// @vitest-environment jsdom
// NS-6B UI-2: a file that is not text (a binary, an archive, a PDF, a DOCX) opens in a tab. A raster picture
// still opens in the program Windows has for it, and the menu keeps both ways to reach the file outside Hivemind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => { sent.push({ cmd, args }); return null; }) }));

const { NotebookTree } = await import("./NotebookTree");
const { useWorkspace } = await import("../../workspace/store");

let root: Root | null = null;
const notebook = { id: "nb-1", path: "C:\\notes", title: "Notes", added: "" };
const other = (path: string) => ({ path, kind: "other", size: 9, mtimeMs: 0 });
const entries = [other("blob.bin"), other("photo.PNG"), other("manual.pdf"), other("data.zip"), { path: "Inbox.md", kind: "page", size: 5, mtimeMs: 0 }];

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["notebook-tree", notebook.id], { entries, truncated: false });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><NotebookTree notebook={notebook} onSettings={() => {}} /></QueryClientProvider>));
}
const row = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=treeitem]")].find((r) => r.textContent?.trim().startsWith(name))!;
const click = (name: string) => act(async () => { row(name).click(); });
const tabs = () => useWorkspace.getState().panes[0].tabs;
const reveals = () => sent.filter((s) => s.cmd === "file_reveal").map((s) => [s.args.path, s.args.open]);
const menuTexts = () => [...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent);

beforeEach(() => { sent.length = 0; useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} }); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("clicking a file that is not text in the notebook tree", () => {
  it("opens a binary file and an archive in a file tab, not in Explorer", async () => {
    await mount();
    await click("blob.bin");
    expect(tabs().map((t) => t.file)).toEqual([{ notebook: "nb-1", path: "blob.bin" }]);
    await click("data.zip");
    expect(tabs().map((t) => t.file?.path)).toEqual(["blob.bin", "data.zip"]);
    expect(reveals()).toEqual([]);
  });

  it("still opens a raster picture in the program Windows has for it, while PDFs open in a tab", async () => {
    await mount();
    await click("photo.PNG");
    expect(reveals()).toEqual([["photo.PNG", true]]);
    expect(tabs()).toHaveLength(0);
    await click("manual.pdf");
    expect(tabs().map((t) => t.file)).toEqual([{ notebook: "nb-1", path: "manual.pdf" }]);
    expect(reveals()).toEqual([["photo.PNG", true]]);
  });

  it("keeps Open with default app and Show in Explorer in the file's menu", async () => {
    await mount();
    await act(async () => { row("blob.bin").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(menuTexts()).toContain("Open with default app");
    expect(menuTexts()).toContain("Show in Explorer");
    await act(async () => { ([...document.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === "Open with default app") as HTMLElement).click(); });
    expect(reveals()).toEqual([["blob.bin", true]]);
  });
});
