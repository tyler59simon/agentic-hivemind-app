// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const openedUrls: string[] = [];
let holdDocxSave: (() => void) | null = null;

const mockDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Spec Title" }] },
    { type: "paragraph", content: [{ type: "text", text: "Body copy" }] },
    { type: "docxRawBlock", attrs: { label: "Word content control", xml: "<w:sdt/>" } },
  ],
};

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async (url: string) => { openedUrls.push(url); }),
}));

vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_data: ArrayBuffer, el: HTMLElement) => {
    el.innerHTML = '<div class="docx-wrapper"><section>Rendered Word Layout <a href="https://example.com">External</a><a href="#sec">Jump</a><h2 id="sec">Section</h2></section></div>';
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
        if (holdDocxSave) await new Promise<void>((r) => { const fn = holdDocxSave; holdDocxSave = () => { r(); fn?.(); }; });
        return { status: "saved", sha256: "sha-docx-2", size: 4200, mtimeMs: 2 };
      default: return null;
    }
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("../notes/FileTab");
const { retargetAll, startDocumentSync } = await import("../../documents/sync");
const { unsavedBinaryFiles, useWorkspace } = await import("../../workspace/store");
const { docxKey, editDocx, saveDocxSession, useDocxStore } = await import("./store");

let root: Root | null = null;
beforeEach(() => {
  calls.length = 0;
  openedUrls.length = 0;
  holdDocxSave = null;
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
  it("routes .docx files to DocxTab in Preview mode, intercepts hyperlinks safely, and uses zero iframes", async () => {
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

    // Clicking a link in Word Preview intercepts navigation and opens through the system opener.
    const link = el.querySelector<HTMLAnchorElement>("a[href]");
    expect(link).not.toBeNull();
    let defaultPrevented = false;
    await act(async () => {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      link!.dispatchEvent(ev);
      defaultPrevented = ev.defaultPrevented;
    });
    expect(defaultPrevented).toBe(true);
    expect(openedUrls).toEqual(["https://example.com"]);
  });

  it("scrolls to an in-document link smoothly, and without animation when the system asked for less motion (DESK-A11Y A4)", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    let reduced = false;
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion") && reduced, addEventListener() {}, removeEventListener() {} }));
    try {
      useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path: "Spec.docx" }, mode: "preview" });
      const el = document.createElement("div");
      document.body.append(el);
      root = createRoot(el);
      await act(async () => {
        root!.render(<QueryClientProvider client={new QueryClient()}><FileTab tab={useWorkspace.getState().panes[0].tabs[0]} /></QueryClientProvider>);
      });
      await until(() => el.textContent?.includes("Rendered Word Layout"));
      const jump = [...el.querySelectorAll<HTMLAnchorElement>("a[href]")].find((a) => a.getAttribute("href") === "#sec")!;
      await act(async () => { jump.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
      expect(scroll).toHaveBeenLastCalledWith({ behavior: "smooth", block: "start" });
      reduced = true;
      await act(async () => { jump.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
      expect(scroll).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not mark clean .docx dirty when opening Edit mode, tracks dirty edits, retains in-flight edits, retargets on rename, and evicts on close", async () => {
    const stop = startDocumentSync();
    try {
      const ref = { notebook: "nb-1", path: "Spec.docx" };
      useWorkspace.getState().openTab({ kind: "file", file: ref, mode: "edit" });
      const paneId = useWorkspace.getState().panes[0].id;
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

      // Opening Edit mode without typing must stay clean!
      const key = docxKey(ref);
      expect(useDocxStore.getState().sessions[key].status).toBe("clean");
      expect(useWorkspace.getState().dirty[tab.id]).toBeFalsy();

      await act(async () => {
        editDocx(key, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited" }] }] });
      });
      expect(useWorkspace.getState().dirty[tab.id]).toBe(true);
      expect(unsavedBinaryFiles(useWorkspace.getState())).toBe(true);

      // Hold save in flight, edit again while saving -> newer edit survives and session stays dirty.
      holdDocxSave = () => {};
      const savePromise = saveDocxSession(key);
      await until(() => calls.some((c) => c.cmd === "docx_save"));
      editDocx(key, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Typed during save" }] }] });
      holdDocxSave();
      const saved = await savePromise;
      expect(saved).toBe(true);
      const saveCall = calls.find((c) => c.cmd === "docx_save");
      expect(saveCall?.args.pre).toEqual({ sha256: "sha-docx-1", size: 4096, mtimeMs: 1 });
      expect(useDocxStore.getState().sessions[key].status).toBe("dirty");
      expect(JSON.stringify(useDocxStore.getState().sessions[key].doc)).toContain("Typed during save");

      // Rename carries the edited .docx session cleanly
      retargetAll("nb-1", "Spec.docx", "Spec-v2.docx");
      const newKey = docxKey({ notebook: "nb-1", path: "Spec-v2.docx" });
      expect(useDocxStore.getState().sessions[key]).toBeUndefined();
      expect(JSON.stringify(useDocxStore.getState().sessions[newKey].doc)).toContain("Typed during save");

      // Closing the last tab evicts the session
      await act(async () => {
        useWorkspace.getState().closeTab(paneId, tab.id);
      });
      expect(useDocxStore.getState().sessions[newKey]).toBeUndefined();
    } finally {
      stop();
    }
  });
});
