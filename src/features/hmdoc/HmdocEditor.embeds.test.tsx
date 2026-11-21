// @vitest-environment jsdom
// NS-3D: inserting and changing embeds in the rich page editor, through the Insert menu, the slash menu and a double-click.
// Living Memory, the Architecture Suite, pdf.js and the drawing editor are mocked; the editor, the pickers and the
// validator are the real ones.
import type { Editor } from "@tiptap/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "../editor/rich/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const lm = vi.hoisted(() => ({
  read: vi.fn(), list: vi.fn(), search: vi.fn(), domains: vi.fn(), systems: vi.fn(),
  systemDiagram: vi.fn(), systemArchitecture: vi.fn(), drawPage: vi.fn(), openNote: vi.fn(),
}));
vi.mock("../../lib/lm", () => ({
  read: lm.read, list: lm.list, search: lm.search, domains: lm.domains, systems: lm.systems,
  LmError: class LmError extends Error { constructor(public code: string, message: string, public exitCode: number) { super(message); } },
}));
vi.mock("../../lib/architecture", () => ({ systemDiagram: lm.systemDiagram, systemArchitecture: lm.systemArchitecture }));
vi.mock("../../workspace/store", () => ({ useWorkspace: { getState: () => ({ openNote: lm.openNote }) } }));
vi.mock("./blocks/pdf", () => ({ drawPage: lm.drawPage }));
vi.mock("../review/language", () => ({ loadLanguage: vi.fn(async () => null) }));
// The drawing editor has its own tests; here it is a stub that reports what it was given and finishes on a click.
vi.mock("./blocks/DrawingDialog", () => ({
  DrawingDialog: (p: { existing: { scene: string; preview: string } | null; apply(n: { scene: string; preview: string }, r: string | null): boolean; stillUsed(path: string): boolean; onClose(): void }) => (
    <div role="dialog" aria-label="Drawing stub" data-existing={p.existing?.scene ?? ""}>
      <button onClick={() => { const ok = p.apply({ scene: "attachments/New.excalidraw", preview: "attachments/New.png" }, p.existing?.scene ?? null); (window as unknown as { applied: unknown }).applied = { ok, old: p.existing ? p.stillUsed(p.existing.preview) : null }; p.onClose(); }}>Finish drawing</button>
      <button onClick={p.onClose}>Close drawing</button>
    </div>
  ),
}));

const { default: HmdocEditor } = await import("./HmdocEditor");
const { stringifyEnvelope } = await import("./envelope");
const { inspect } = await import("./validate");
const { hashLines } = await import("./blocks/codeRange");
const { FREEFORM_REFUSED } = await import("./blocks/items");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
beforeEach(() => {
  for (const f of Object.values(lm)) f.mockReset();
  lm.read.mockResolvedValue({ title: "T", type: "knowledge", status: "active", body: "x" });
  lm.drawPage.mockResolvedValue({ ok: true, pages: 9 });
  lm.systemDiagram.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
  (window as unknown as { applied: unknown }).applied = undefined;
});

const FILES = ["docs/Spec.pdf", "docs/Other.pdf", "pics/a.png", "pics/b.png", "pics/c.jpg", "src/app.ts", "notes.md", "logo.svg"];
const SOURCE = ["export const a = 1;", "export const b = 2;", "export const c = 3;", "export const d = 4;"].join("\n");

function context(over: Partial<RichContext> = {}): RichContext {
  const notebook = {
    files: FILES, url: (p: string) => `http://hmfile.localhost/g/${p}`,
    read: vi.fn(async (path: string) => { if (path === "src/app.ts") return { text: SOURCE, binary: false }; throw new Error("no file"); }),
    create: vi.fn(), save: vi.fn(), trash: vi.fn(),
  };
  return { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(), notebook, attachPath: vi.fn(), ...over } as unknown as RichContext;
}

const p = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const fileOf = (content: unknown[]) => stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta: {}, content: { type: "doc", content } } as never);
const parsed = (text: string) => JSON.parse(text) as { content: { content: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }[] } };

async function mount(content: unknown[], ctx = context()) {
  const changes: string[] = [];
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(
    <HmdocEditor text={fileOf(content)} version={1} readOnly={false} onChange={(x) => changes.push(x)} onSave={vi.fn()} ctx={ctx} pictures={[]} invalid={(r): ReactNode => <div>{r}</div>} />,
  ));
  await settle();
  const editor = () => (el.querySelector(".rich-doc") as HTMLElement & { editor: Editor }).editor;
  return { el, changes, editor, last: () => parsed(changes[changes.length - 1]) };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = async (e: Element | null | undefined) => { await act(async () => { (e as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const setValue = async (e: Element | null, v: string) => {
  const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(e, v); e!.dispatchEvent(new Event(e instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const byText = (root: ParentNode, sel: string, text: string | RegExp) => [...root.querySelectorAll(sel)].find((x) => (typeof text === "string" ? x.textContent === text : text.test(x.textContent ?? ""))) ?? null;
const insertMenu = async (el: HTMLElement, label: string) => {
  await click(el.querySelector('[aria-label="Insert an embed"]'));
  await click(byText(el, "[role=menuitem]", new RegExp(`^${label}`)));
};
const modal = () => document.body.querySelector("[role=dialog]") as HTMLElement | null;

describe("opening a page of embeds", () => {
  it("draws every embed and writes nothing", async () => {
    const { changes, el } = await mount([
      { type: "noteCard", attrs: { ref: "sandbox:ab12", title: "Note" } },
      { type: "pdfPage", attrs: { file: "docs/Spec.pdf", page: 2, title: "" } },
      { type: "gallery", attrs: { images: ["pics/a.png"], columns: 2, title: "" } },
      { type: "excalidraw", attrs: { scene: "d.excalidraw", preview: "d.png", title: "" } },
      { type: "freeform", attrs: { height: 240 }, content: [{ type: "frame", attrs: { x: 16, y: 16, w: 160, h: 64, z: 1 }, content: [p("in a frame")] }] },
    ]);
    await settle();
    for (const cls of [".hm-notecard", ".hm-pdf", ".hm-gallery", ".hm-drawing-block", ".hm-freeform .hm-frame"]) expect(el.querySelector(cls), cls).not.toBeNull();
    expect(changes).toEqual([]);
  });
});

describe("the Insert menu", () => {
  it("lists every kind of embed and the free-positioned block", async () => {
    const { el } = await mount([p("")]);
    await click(el.querySelector('[aria-label="Insert an embed"]'));
    expect([...el.querySelectorAll("[role=menuitem]")].map((b) => b.firstChild!.textContent!.trim())).toEqual([
      "Memory note", "Architecture diagram", "Code range", "PDF page", "Gallery", "Drawing", "Free-positioned block",
    ]);
  });

  it("a PDF page: the picker lists the notebook's PDFs, and the page is saved with the file", async () => {
    const m = await mount([p("")]);
    await insertMenu(m.el, "PDF page");
    const dialog = modal()!;
    expect([...dialog.querySelectorAll("select option")].map((o) => o.textContent)).toEqual(["Choose a PDF", "docs/Other.pdf", "docs/Spec.pdf"]);
    expect(byText(dialog, "button", /^Embed/)!.hasAttribute("disabled")).toBe(true);
    await setValue(dialog.querySelector("select"), "docs/Spec.pdf");
    await setValue(dialog.querySelector('input[aria-label="Page"]'), "3");
    await click(byText(dialog, "button", "Embed page 3"));
    expect(modal()).toBeNull();
    const node = m.last().content.content[0];
    expect(node).toEqual({ type: "pdfPage", attrs: { file: "docs/Spec.pdf", page: 3, title: "" } });
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
    expect(lm.drawPage).toHaveBeenCalled();
  });

  it("a gallery: the pictures show in the order they were chosen, in the columns chosen", async () => {
    const m = await mount([p("")]);
    await insertMenu(m.el, "Gallery");
    const dialog = modal()!;
    expect([...dialog.querySelectorAll('input[type=checkbox]')].map((c) => c.getAttribute("aria-label"))).toEqual(["logo.svg", "pics/a.png", "pics/b.png", "pics/c.jpg"]);
    expect(byText(dialog, "button", /^Embed/)!.hasAttribute("disabled")).toBe(true);
    await click(dialog.querySelector('input[aria-label="pics/c.jpg"]'));
    await click(dialog.querySelector('input[aria-label="pics/a.png"]'));
    await setValue(dialog.querySelector('select[aria-label="Columns"]'), "2");
    await setValue(dialog.querySelector('input[aria-label="Title"]'), "  Screens ");
    await click(byText(dialog, "button", "Embed 2 pictures"));
    expect(m.last().content.content[0]).toEqual({ type: "gallery", attrs: { images: ["pics/c.jpg", "pics/a.png"], columns: 2, title: "Screens" } });
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
  });

  it("a gallery can take pictures from outside the notebook: they are attached, listed and chosen", async () => {
    const attachPath = vi.fn(async (_b: Uint8Array, name: string) => (name === "bad.png" ? Promise.reject(new Error("too big")) : `attachments/${name}`));
    const ctx = context({ attachPath });
    const m = await mount([p("")], ctx);
    await insertMenu(m.el, "Gallery");
    const dialog = modal()!;
    await click(dialog.querySelector('input[aria-label="pics/b.png"]'));
    const input = dialog.querySelector('input[aria-label="Add pictures"]') as HTMLInputElement;
    const file = (name: string) => ({ name, type: "image/png", arrayBuffer: async () => new Uint8Array([1, 2]).buffer });
    Object.defineProperty(input, "files", { value: [file("New shot.png"), file("bad.png"), { ...file("notes.txt"), type: "text/plain" }], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
    expect(attachPath.mock.calls.map((c) => c[1])).toEqual(["New shot.png", "bad.png"]);
    expect(ctx.fail).toHaveBeenCalledWith("bad.png was not attached: too big");
    expect(dialog.querySelector('input[aria-label="attachments/New shot.png"]')).not.toBeNull();
    await click(byText(dialog, "button", "Embed 2 pictures"));
    expect(m.last().content.content[0].attrs!.images).toEqual(["pics/b.png", "attachments/New shot.png"]);
  });

  it("a code range: the lines are stored with their hash, and a range that is not in the file cannot be embedded", async () => {
    const m = await mount([p("")]);
    await insertMenu(m.el, "Code range");
    const dialog = modal()!;
    // Binary kinds are not offered.
    expect([...dialog.querySelectorAll("select option")].map((o) => o.textContent)).toEqual(["Choose a file", "notes.md", "src/app.ts"]);
    await setValue(dialog.querySelector('select[aria-label="File"]'), "src/app.ts");
    await settle();
    await setValue(dialog.querySelector('input[aria-label="Last line"]'), "9");
    expect(dialog.querySelector("[role=alert]")!.textContent).toBe("The file has 4 lines.");
    expect(byText(dialog, "button", /^Embed/)!.hasAttribute("disabled")).toBe(true);
    await setValue(dialog.querySelector('input[aria-label="First line"]'), "2");
    await setValue(dialog.querySelector('input[aria-label="Last line"]'), "3");
    expect(dialog.querySelector('pre[aria-label="Preview"]')!.textContent).toBe("export const b = 2;\nexport const c = 3;");
    await click(byText(dialog, "button", "Embed src/app.ts:2-3"));
    expect(m.last().content.content[0].attrs).toEqual({
      file: "src/app.ts", from: 2, to: 3, text: "export const b = 2;\nexport const c = 3;", language: "ts", title: "",
      sha256: hashLines(["export const b = 2;", "export const c = 3;"]),
    });
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
  });

  it("a memory note: with no search it lists notes, with one it searches, and the pick is saved by reference", async () => {
    lm.list.mockResolvedValue({ notes: [{ ref: "sandbox:n1", title: "First note", type: "decision", status: "active", domain: "sandbox", tags: [], updated: "", summary: "" }] });
    lm.domains.mockResolvedValue({ domains: [{ name: "sandbox" }] });
    lm.search.mockResolvedValue({ results: [{ id: "x1", domain: "sandbox", title: "Found it", type: "knowledge", status: "active", tags: [], updated: "", snippet: "" }] });
    const m = await mount([p("")]);
    await insertMenu(m.el, "Memory note");
    await settle();
    const dialog = modal()!;
    expect(dialog.querySelector('[aria-label="Notes"]')!.textContent).toContain("First note");
    await setValue(dialog.querySelector('input[aria-label="Search notes"]'), "found");
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(lm.search).toHaveBeenCalledWith({ query: "found", domain: "sandbox", scope: "all", limit: 20 });
    await click(byText(dialog, "button", /Found it/));
    expect(m.last().content.content[0]).toEqual({ type: "noteCard", attrs: { ref: "sandbox:x1", title: "Found it" } });
  });

  it("an architecture diagram: the system's manifest diagrams are listed, and the pick keeps the slug and the path", async () => {
    lm.systems.mockResolvedValue({ systems: [{ slug: "hive", name: "Hivemind" }] });
    lm.systemArchitecture.mockResolvedValue({ diagrams: [{ path: "diagrams/container.svg", level: "container", format: "svg" }], error: null });
    const m = await mount([p("")]);
    await insertMenu(m.el, "Architecture diagram");
    await settle();
    const dialog = modal()!;
    await setValue(dialog.querySelector('select[aria-label="System"]'), "hive");
    await settle();
    expect(lm.systemArchitecture).toHaveBeenCalledWith("hive");
    await click(byText(dialog, "button", /diagrams\/container\.svg/));
    expect(m.last().content.content[0]).toEqual({ type: "diagram", attrs: { system: "hive", path: "diagrams/container.svg", title: "Hivemind, container" } });
  });

  it("an embed that is not in a folder notebook says so, and cancelling changes nothing", async () => {
    const m = await mount([p("")], context({ notebook: undefined }));
    await insertMenu(m.el, "PDF page");
    expect(modal()!.textContent).toContain("not in a folder notebook");
    await click(byText(modal()!, "button", "Close"));
    expect(modal()).toBeNull();
    expect(m.changes).toEqual([]);
  });

  it("Cancel leaves the page as it was", async () => {
    const m = await mount([p("text")]);
    await insertMenu(m.el, "Gallery");
    await click(byText(modal()!, "button", "Cancel"));
    expect(m.changes).toEqual([]);
    expect(m.editor().state.doc.childCount).toBe(1);
  });
});

describe("the slash menu", () => {
  it("offers the embeds, and Enter on one opens its picker", async () => {
    const m = await mount([p("Text")]);
    const e = m.editor();
    await act(async () => { e.commands.setTextSelection(e.state.doc.content.size - 1); e.commands.splitBlock(); e.commands.insertContent("/gall"); });
    expect([...m.el.querySelectorAll(".rich-slash [role=option]")].map((o) => o.querySelector("span")!.textContent)).toEqual(["Gallery"]);
    await act(async () => { e.view.someProp("handleKeyDown", (f) => f(e.view, new KeyboardEvent("keydown", { key: "Enter" }))); });
    await settle();
    expect(modal()!.getAttribute("aria-label")).toBe("Embed a gallery");
    // The /gall text is gone and the page now holds only the text before it.
    expect(e.state.doc.textContent).toBe("Text");
  });

  it("lists the free-positioned block and the drawing", async () => {
    const m = await mount([p("")]);
    const e = m.editor();
    await act(async () => { e.commands.insertContent("/draw"); });
    expect(m.el.querySelector(".rich-slash")!.textContent).toContain("Drawing");
  });
});

describe("changing an embed", () => {
  it("a double-click opens the picker with what is there, and the pick changes that embed only", async () => {
    const m = await mount([
      { type: "pdfPage", attrs: { file: "docs/Spec.pdf", page: 2, title: "" } },
      { type: "pdfPage", attrs: { file: "docs/Spec.pdf", page: 8, title: "" } },
    ]);
    await act(async () => { m.el.querySelector(".hm-pdf")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const dialog = modal()!;
    expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("docs/Spec.pdf");
    expect((dialog.querySelector('input[aria-label="Page"]') as HTMLInputElement).value).toBe("2");
    await setValue(dialog.querySelector('input[aria-label="Page"]'), "5");
    await click(byText(dialog, "button", "Embed page 5"));
    expect(m.last().content.content.map((n) => n.attrs!.page)).toEqual([5, 8]);
  });
});

describe("drawings", () => {
  it("a new drawing's block is inserted when the drawing editor finishes, and nothing is written before", async () => {
    const m = await mount([p("")]);
    await insertMenu(m.el, "Drawing");
    expect(modal()!.getAttribute("aria-label")).toBe("Drawing stub");
    expect(modal()!.getAttribute("data-existing")).toBe("");
    expect(m.changes).toEqual([]);
    await click(byText(modal()!, "button", "Finish drawing"));
    expect(m.last().content.content[0]).toEqual({ type: "excalidraw", attrs: { scene: "attachments/New.excalidraw", preview: "attachments/New.png", title: "Drawing" } });
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
  });

  it("Close in the drawing editor writes nothing", async () => {
    const m = await mount([p("")]);
    await insertMenu(m.el, "Drawing");
    await click(byText(modal()!, "button", "Close drawing"));
    expect(m.changes).toEqual([]);
  });

  it("Edit drawing opens the block's drawing; when it finishes every block of that scene takes the new preview, so none keeps one that is gone", async () => {
    const block = { type: "excalidraw", attrs: { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png", title: "Sketch" } };
    const m = await mount([block, p("between"), { ...block, attrs: { ...block.attrs, title: "Copy" } }, { type: "excalidraw", attrs: { scene: "other.excalidraw", preview: "other.png", title: "" } }]);
    await click(m.el.querySelector(".hm-drawing-edit"));
    expect(modal()!.getAttribute("data-existing")).toBe("attachments/Sketch.excalidraw");
    await click(byText(modal()!, "button", "Finish drawing"));
    const blocks = m.last().content.content.filter((n) => n.type === "excalidraw");
    expect(blocks.map((b) => [b.attrs!.scene, b.attrs!.preview, b.attrs!.title])).toEqual([
      ["attachments/New.excalidraw", "attachments/New.png", "Sketch"],
      ["attachments/New.excalidraw", "attachments/New.png", "Copy"],
      ["other.excalidraw", "other.png", ""],
    ]);
    // The old preview is no longer shown by any block, so it may go to the trash.
    expect((window as unknown as { applied: { ok: boolean; old: boolean } }).applied).toEqual({ ok: true, old: false });
  });

  it("a drawing whose block was deleted while the editor was open is not applied", async () => {
    const m = await mount([{ type: "excalidraw", attrs: { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png", title: "" } }, p("x")]);
    await click(m.el.querySelector(".hm-drawing-edit"));
    await act(async () => { m.editor().view.dispatch(m.editor().state.tr.delete(0, m.editor().state.doc.firstChild!.nodeSize)); });
    await click(byText(modal()!, "button", "Finish drawing"));
    expect((window as unknown as { applied: { ok: boolean } }).applied.ok).toBe(false);
  });
});

describe("free-positioned blocks", () => {
  it("the menu inserts one with a frame, and a second one is refused inside it", async () => {
    const ctx = context();
    const m = await mount([p("")], ctx);
    await insertMenu(m.el, "Free-positioned block");
    const first = m.last().content.content[0];
    expect(first.type).toBe("freeform");
    expect(first.attrs).toEqual({ height: 240 });
    expect(first.content).toHaveLength(1);
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
    // The cursor is in the frame now.
    const count = m.changes.length;
    await insertMenu(m.el, "Free-positioned block");
    expect(ctx.fail).toHaveBeenCalledWith(FREEFORM_REFUSED);
    expect(m.changes.length).toBe(count);
  });

  it("an embed can go into a frame", async () => {
    const m = await mount([{ type: "freeform", attrs: { height: 240 }, content: [{ type: "frame", attrs: { x: 16, y: 16, w: 160, h: 64, z: 1 }, content: [p("")] }] }]);
    await act(async () => { m.editor().commands.setTextSelection(3); });
    await insertMenu(m.el, "PDF page");
    await setValue(modal()!.querySelector("select"), "docs/Spec.pdf");
    await click(byText(modal()!, "button", /^Embed page/));
    const frame = m.last().content.content[0].content![0] as { content: { type: string }[] };
    expect(frame.content.map((n) => n.type)).toEqual(["pdfPage"]);
    expect(inspect(m.changes[m.changes.length - 1]).ok).toBe(true);
  });
});
