// @vitest-environment jsdom
// NS-3D: what a rich page's context gives its embeds: the page's own notebook's files, only for a page of a folder notebook, with
// URLs through the page's picture grant and paths checked as the file commands check them.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ readFile: vi.fn(async () => ({ text: "x" })), createFile: vi.fn(async () => ({})), saveFile: vi.fn(async () => ({ status: "saved" })), deleteFile: vi.fn(async () => "trash/x") }));
vi.mock("../../documents/io", () => ({ readDoc: vi.fn(), attachBytes: vi.fn(), attachDropped: vi.fn() }));
vi.mock("./actions", () => ({ openPage: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toast: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/notebooks", async (original) => ({ ...(await original<typeof import("../../lib/notebooks")>()), ...files }));

import type { RichContext } from "../editor/rich/context";
import { useRichPage, type RichPage } from "./richPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function richFor(page: Partial<RichPage>): Promise<RichContext> {
  let got!: RichContext;
  function Probe() { got = useRichPage({ ref: { notebook: "nb-1", path: "Plans/A.hmdoc" }, files: ["Plans/A.hmdoc", "docs/Spec.pdf"], base: "http://hmfile.localhost/g1/", loose: false, follow: vi.fn(), takesLink: () => true, ...page }); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  return got;
}

describe("the notebook of a rich page", () => {
  it("is the page's own folder notebook, with its files", async () => {
    const rich = await richFor({});
    expect(rich.notebook!.files).toEqual(["Plans/A.hmdoc", "docs/Spec.pdf"]);
  });

  it("gives a URL under the picture grant, from the notebook's root and not the page's folder", async () => {
    const { notebook } = await richFor({});
    expect(notebook!.url("docs/Spec.pdf")).toBe("http://hmfile.localhost/g1/docs/Spec.pdf");
    expect(notebook!.url("pictures/my photo (1).png")).toBe("http://hmfile.localhost/g1/pictures/my%20photo%20(1).png");
    expect(notebook!.url("100% done/a.png")).toBe("http://hmfile.localhost/g1/100%25%20done/a.png");
  });

  it("gives no URL for a path that climbs out, is absolute or hidden, or before the grant is known", async () => {
    const { notebook } = await richFor({});
    for (const bad of ["../a.png", "/a.png", "C:/a.png", ".git/a.png", "a/../../b.png", "a\\b.png", "", "https://example.com/a.png"]) expect(notebook!.url(bad), bad).toBeNull();
    expect((await richFor({ base: undefined })).notebook!.url("a.png")).toBeNull();
  });

  it("reads, creates, saves and trashes in that notebook", async () => {
    const { notebook } = await richFor({});
    const stamp = { sha256: "a", size: 1, mtimeMs: 2 };
    const format = { encoding: "utf-8", bom: false, eol: "lf" as const };
    await notebook!.read("src/a.ts");
    await notebook!.create("attachments/D.excalidraw", "{}");
    await notebook!.save("attachments/D.excalidraw", "{1}", stamp, format);
    await notebook!.trash("attachments/D.png");
    expect(files.readFile).toHaveBeenCalledWith("nb-1", "src/a.ts");
    expect(files.createFile).toHaveBeenCalledWith("nb-1", "attachments/D.excalidraw", "{}");
    expect(files.saveFile).toHaveBeenCalledWith("nb-1", "attachments/D.excalidraw", "{1}", stamp, format);
    expect(files.deleteFile).toHaveBeenCalledWith("nb-1", "attachments/D.png");
  });

  it("writes nothing for a page that cannot take changes now", async () => {
    files.createFile.mockClear();
    files.saveFile.mockClear();
    files.deleteFile.mockClear();
    const { notebook } = await richFor({ takesLink: () => false });
    await expect(Promise.resolve().then(() => notebook!.create("a.excalidraw", "{}"))).rejects.toThrow("cannot take");
    await expect(Promise.resolve().then(() => notebook!.save("a.excalidraw", "{}", { sha256: "a", size: 1, mtimeMs: 2 }, { encoding: "utf-8", bom: false, eol: "lf" }))).rejects.toThrow("cannot take");
    await expect(Promise.resolve().then(() => notebook!.trash("a.png"))).rejects.toThrow("cannot take");
    expect(files.createFile).not.toHaveBeenCalled();
    expect(files.saveFile).not.toHaveBeenCalled();
    expect(files.deleteFile).not.toHaveBeenCalled();
  });

  it("is absent for a loose file", async () => {
    expect((await richFor({ loose: true })).notebook).toBeUndefined();
  });
});
