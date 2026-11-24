// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const mockDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Spec Title" }] },
    { type: "paragraph", content: [{ type: "text", text: "Body copy" }] },
    { type: "docxRawBlock", attrs: { label: "Word content control", xml: "<w:sdt/>" } },
  ],
};

vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_data: ArrayBuffer, el: HTMLElement) => {
    el.innerHTML = '<div class="docx-wrapper"><section>Rendered Word Layout</section></div>';
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "docx_read":
        return {
          doc: mockDoc,
          media: {},
          sha256: "sha-docx-1",
          size: 4096,
          mtimeMs: 1,
          readOnly: null,
          warnings: [{ kind: "comments", message: "Contains Word comments." }],
          hasHeadersFooters: true,
        };
      case "docx_raw":
        return new ArrayBuffer(16);
      case "docx_save":
        return { status: "saved", sha256: "sha-docx-2", size: 4200, mtimeMs: 2 };
      default: return null;
    }
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("../notes/FileTab");
const { useWorkspace } = await import("../../workspace/store");
const { docxKey, editDocx, saveDocxSession, useDocxStore } = await import("./store");

let root: Root | null = null;
beforeEach(() => {
  calls.length = 0;
  useDocxStore.setState({ sessions: {}, refs: {} });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function until(check: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error("timed out");
}

describe("DocxTab & DocxStore", () => {
  it("routes .docx files to DocxTab in Preview mode without calling text file_read or using an iframe", async () => {
    useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "Spec.docx" }, mode: "preview" });
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={useWorkspace.getState().panes[0].tabs[0]} /></QueryClientProvider>);
    });
    await until(() => el.textContent?.includes("Rendered Word Layout"));
    expect(calls.some((c) => c.cmd === "file_read")).toBe(false);
    expect(calls.some((c) => c.cmd === "docx_read")).toBe(true);
    expect(document.querySelector("iframe")).toBeNull();
    expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Preview", "Edit", "History"]);
  });

  it("shows fidelity warnings in Edit mode, tracks dirty state, and saves with SHA-256 precondition", async () => {
    const ref = { notebook: "nb-1", path: "Spec.docx" };
    useWorkspace.getState().openTab({ kind: "file", file: ref, mode: "edit" });
    const tab = useWorkspace.getState().panes[0].tabs[0];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={tab} /></QueryClientProvider>);
    });
    await until(() => el.querySelector(".docx-rich-body"));
    expect(el.textContent).toContain("Headers, footers, styles, and page setup are preserved");
    expect(el.textContent).toContain("Contains Word comments");
    expect(el.textContent).toContain("Word content control (preserved on save)");
    expect(document.querySelector("iframe")).toBeNull();

    const key = docxKey(ref);
    await act(async () => {
      editDocx(key, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited" }] }] });
    });
    expect(useWorkspace.getState().dirty[tab.id]).toBe(true);

    let saved = false;
    await act(async () => { saved = await saveDocxSession(key); });
    expect(saved).toBe(true);
    const saveCall = calls.find((c) => c.cmd === "docx_save");
    expect(saveCall?.args.pre).toEqual({ sha256: "sha-docx-1", size: 4096, mtimeMs: 1 });
    expect(useWorkspace.getState().dirty[tab.id]).toBe(false);
  });
});
