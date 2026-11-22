// @vitest-environment jsdom
// NS-6B in a mounted file tab: a file over 64 MB and a binary file open in the large file viewer, and any file's menu offers it
// and the hex view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Mounting an editor and loading a grammar is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
const utf8 = { encoding: "UTF-8", bom: false, eol: "lf", confidence: "valid" };
const window_ = { first: 0, lines: [{ number: 0, text: "first line of the big file", cut: false }], total: 1, indexed: true, size: 70_000_000 };
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    const path = a?.path as string;
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [], truncated: false };
      case "file_read":
        if (path === "huge.log") throw new Error("C:\\nb\\huge.log is larger than 64 MB, too large to edit");
        if (path === "blob.bin") return { text: "", sha256: "sha-bin", size: 9, mtimeMs: 1, format: utf8, readOnly: "This is not a text file", binary: true, convertible: false };
        return { text: "plain text", sha256: "sha-1", size: 10, mtimeMs: 1, format: utf8, readOnly: null, binary: false };
      case "bigfile_open": return { handle: "h1", size: 70_000_000, encoding: "UTF-8", bom: false, binary: path === "blob.bin", first: window_ };
      case "bigfile_lines": return window_;
      case "bigfile_bytes": return [0x50, 0x4b, 3, 4];
      case "asset_base": return "http://hmfile.localhost/g/";
      case "draft_get": return null;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("./FileTab");
const { useWorkspace } = await import("../../workspace/store");
const { startDocumentSync } = await import("../../documents/sync");

let root: Root | null = null;
let stop = () => {};
let el: HTMLElement;
const settle = () => act(async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0)); });
const tab = () => useWorkspace.getState().panes[0].tabs[0];

async function show(path: string, mode?: "source" | "bigfile" | "hex") {
  useWorkspace.getState().openTab({ kind: "file", file: { notebook: "nb-1", path }, mode });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const node = (): ReactNode => <QueryClientProvider client={new QueryClient()}><FileTab tab={tab()} /></QueryClientProvider>;
  await act(async () => { root!.render(node()); });
  await settle();
  return async () => { await act(async () => { root!.render(node()); }); await settle(); };
}
const menuItem = async (text: string) => {
  await act(async () => { (el.querySelector("[aria-label='Page actions']") as HTMLElement).click(); });
  const item = [...el.querySelectorAll("[role=menuitem]")].find((i) => i.textContent === text) as HTMLElement | undefined;
  return item;
};

beforeEach(() => {
  sent.length = 0;
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} });
  stop = startDocumentSync();
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  stop();
  el?.remove();
});

describe("a file tab and the large file viewer", () => {
  it("opens a file over 64 MB in the viewer instead of the too-large error", async () => {
    await show("huge.log");
    expect(sent.some((s) => s.cmd === "bigfile_open" && s.args.path === "huge.log")).toBe(true);
    expect(el.textContent).toContain("first line of the big file");
    expect(el.textContent).not.toContain("too large to edit");
    expect(el.querySelector("[aria-label='Jump to line']")).not.toBeNull();
    // No editor and no save button, and no way back to an editor that cannot hold it.
    expect(el.querySelector(".cm-content")).toBeNull();
    expect(el.querySelector("[title='Save (Ctrl+S)']")).toBeNull();
    expect(await menuItem("Open in the editor")).toBeUndefined();
    expect(el.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Large file viewer");
  });

  it("opens a binary file in the hex view, and the other view is one click away", async () => {
    const rerender = await show("blob.bin");
    expect(sent.some((s) => s.cmd === "bigfile_open")).toBe(true);
    expect(el.querySelector("[aria-label='Jump to offset']")).not.toBeNull();
    expect([...el.querySelectorAll(".hex-row .hex-byte")].slice(0, 4).map((b) => b.textContent)).toEqual(["50", "4b", "03", "04"]);
    expect(el.querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Hex view");
    await act(async () => { ([...el.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Large file viewer") as HTMLElement).click(); });
    await rerender();
    expect(tab().mode).toBe("bigfile");
    expect(el.querySelector("[aria-label='Jump to line']")).not.toBeNull();
    expect(el.textContent).toContain("Not a text file");
  });

  it("offers the viewer and the hex view in the menu of an ordinary text file, and can go back", async () => {
    const rerender = await show("notes.txt", "source");
    expect(el.querySelector(".cm-content")).not.toBeNull();
    expect(el.querySelector("[aria-label='Jump to line']")).toBeNull();
    const viewer = await menuItem("Open in large file viewer");
    expect(viewer).toBeDefined();
    expect([...el.querySelectorAll("[role=menuitem]")].some((i) => i.textContent === "Hex view")).toBe(true);
    await act(async () => { viewer!.click(); });
    await rerender();
    expect(tab().mode).toBe("bigfile");
    expect(el.querySelector("[aria-label='Jump to line']")).not.toBeNull();
    expect(el.querySelector(".cm-content")).toBeNull();
    // The file is closed in the viewer when the tab goes back to the editor, and the hex view opens from its tabs.
    await act(async () => { ([...el.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Hex view") as HTMLElement).click(); });
    await rerender();
    expect(tab().mode).toBe("hex");
    expect(sent.filter((s) => s.cmd === "bigfile_close").length).toBeGreaterThanOrEqual(1);
    const back = await menuItem("Open in the editor");
    expect(back).toBeDefined();
    await act(async () => { back!.click(); });
    await rerender();
    expect(tab().mode).toBe("source");
    expect(el.querySelector(".cm-content")).not.toBeNull();
    expect(el.querySelector("[aria-label='Jump to offset']")).toBeNull();
  });

  it("is a column that fills the pane, with the rows as the only thing that scrolls (UI-1)", async () => {
    // jsdom lays nothing out, so this checks the structure the stylesheet bounds, and then the stylesheet's rules.
    for (const mode of ["bigfile", "hex"] as const) {
      useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} });
      await show("notes.txt", mode);
      const page = el.firstElementChild as HTMLElement;
      expect(page.classList.contains("viewer-page")).toBe(true);
      const view = [...page.children].find((c) => c.classList.contains("bigfile-page")) as HTMLElement;
      expect(view, mode).toBeDefined();
      const scroller = [...view.children].find((c) => c.classList.contains("bigfile")) as HTMLElement;
      expect(scroller.firstElementChild!.classList.contains("bigfile-space")).toBe(true);
      await act(async () => { root!.unmount(); });
      el.remove();
      root = null;
    }
    // Vitest hands CSS imports back empty, so the stylesheet is read from the project folder (tests run from it).
    const nodeFs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync: (path: string, encoding: string) => string };
    const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
    const css = nodeFs.readFileSync(`${cwd}/src/App.css`, "utf8");
    const rule = (selector: string) => {
      const found = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].split(",").map((s) => s.trim()).includes(selector));
      if (!found) throw new Error("no rule for " + selector);
      return found[2];
    };
    // The pane body is a bounded flex item that scrolls only what is taller than it; the page is exactly as tall as it.
    expect(rule(".pane-body")).toMatch(/flex:\s*1\b/);
    expect(rule(".pane-body")).toMatch(/min-height:\s*0/);
    expect(rule(".viewer-page")).toMatch(/height:\s*100%/);
    expect(rule(".viewer-page")).toMatch(/overflow:\s*hidden/);
    expect(rule(".viewer-page")).toMatch(/min-height:\s*0/);
    // Inside it a column, whose only growing child scrolls in what is left.
    expect(rule(".bigfile-page")).toMatch(/flex:\s*1\b/);
    expect(rule(".bigfile-page")).toMatch(/flex-direction:\s*column/);
    expect(rule(".bigfile-page")).toMatch(/min-height:\s*0/);
    expect(rule(".bigfile")).toMatch(/flex:\s*1\b/);
    expect(rule(".bigfile")).toMatch(/min-height:\s*0/);
    expect(rule(".bigfile")).toMatch(/overflow:\s*auto/);
    // The tall area is inside the scroller, which clips it, and is the only element given a height of millions of pixels.
    expect(rule(".bigfile-space")).toMatch(/position:\s*relative/);
    // .viewer-page comes after .note-page, so its `min-height: 0` wins over the page's `min-height: 100%`.
    expect(css.indexOf(".viewer-page {")).toBeGreaterThan(css.indexOf(".note-page {"));
  });

  it("keeps the viewer a tab was left in", async () => {
    await show("notes.txt", "hex");
    expect(el.querySelector("[aria-label='Jump to offset']")).not.toBeNull();
    expect(el.querySelector(".cm-content")).toBeNull();
  });
});
