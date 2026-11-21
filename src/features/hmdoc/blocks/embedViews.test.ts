// @vitest-environment jsdom
// NS-3D: how the embeds draw. Living Memory, the Architecture Suite, the notebook's files and pdf.js are mocked; the views
// are the real ones, in a real editor.
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "../../editor/rich/context";
import { withViews } from "../../rich/views";
import { hmdocExtensions } from "../schema";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const readNote = vi.fn();
const systemDiagram = vi.fn();
const openNote = vi.fn();
const drawPage = vi.fn();
vi.mock("../../../lib/lm", () => ({ read: (...a: unknown[]) => readNote(...a) }));
vi.mock("../../../lib/architecture", () => ({ systemDiagram: (...a: unknown[]) => systemDiagram(...a) }));
vi.mock("../../../workspace/store", () => ({ useWorkspace: { getState: () => ({ openNote }) } }));
vi.mock("./pdf", () => ({ drawPage: (...a: unknown[]) => drawPage(...a) }));
vi.mock("../../review/language", () => ({ loadLanguage: vi.fn(async () => null) }));

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const { cardLines, lightboxKey, openLightbox, withEmbedViews } = await import("./embedViews");
const { hashLines, captureRange, fileLines } = await import("./codeRange");

const editors: Editor[] = [];
const edit = vi.fn();
type Files = NonNullable<RichContext["notebook"]>;

function context(files: Partial<Files> | null = {}): RichContext {
  const notebook: Files | undefined = files === null ? undefined : {
    files: [], url: (p) => `http://hmfile.localhost/g/${p.split("/").map(encodeURIComponent).join("/")}`,
    read: vi.fn(async () => { throw new Error("no file"); }), create: vi.fn(), save: vi.fn(), trash: vi.fn(), ...files,
  };
  return { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(), notebook };
}

function mount(blocks: unknown[], ctx: RichContext, editable = true) {
  const el = document.createElement("div");
  document.body.append(el);
  const env = { ctx: () => ctx, edit };
  const editor = new Editor({ element: el, editable, extensions: withEmbedViews(withViews(hmdocExtensions(), env), env), content: { type: "doc", content: blocks } as never });
  editors.push(editor);
  return editor;
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const attrsOf = (editor: Editor) => editor.state.doc.firstChild!.attrs;

beforeEach(() => { readNote.mockReset(); systemDiagram.mockReset(); openNote.mockReset(); drawPage.mockReset(); edit.mockReset(); });
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const noteCard = { type: "noteCard", attrs: { ref: "sandbox:ab12cd34", title: "Plan note" } };

describe("memory note card", () => {
  it("draws the note's title, type, status and first lines, and writes nothing", async () => {
    readNote.mockResolvedValue({ title: "The real title", type: "decision", status: "active", body: "# Heading\n\nThe decision.\n\nWhy it was made.\n\n```\ncode\n```\n\nThird.\n\nFourth.\n\nFifth." });
    const editor = mount([noteCard], context());
    let writes = 0;
    editor.on("update", () => { writes++; });
    await settle();
    const dom = editor.view.dom;
    expect(readNote).toHaveBeenCalledWith("sandbox:ab12cd34");
    expect(dom.querySelector(".hm-card-title")!.textContent).toBe("The real title");
    expect(dom.querySelector(".hm-card-kind")!.textContent).toBe("decision · active");
    expect([...dom.querySelectorAll(".hm-card-body p")].map((p) => p.textContent)).toEqual(["The decision.", "Why it was made.", "Third.", "Fourth."]);
    expect(writes).toBe(0);
  });

  it("a click on the title opens the note's tab, Ctrl+click in a split", async () => {
    readNote.mockResolvedValue({ title: "T", type: "knowledge", status: "active", body: "x" });
    const editor = mount([noteCard], context());
    await settle();
    const title = editor.view.dom.querySelector(".hm-card-title") as HTMLElement;
    title.click();
    expect(openNote).toHaveBeenLastCalledWith("sandbox:ab12cd34", { title: "Plan note", split: false });
    title.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(openNote).toHaveBeenLastCalledWith("sandbox:ab12cd34", { title: "Plan note", split: true });
  });

  it("a note that cannot be read shows a placeholder with the stored title", async () => {
    readNote.mockRejectedValue(new Error("not found"));
    const editor = mount([noteCard], context());
    expect(editor.view.dom.querySelector(".hm-card-title")!.textContent).toBe("Plan note");
    await settle();
    expect(editor.view.dom.querySelector(".hm-notecard")!.classList.contains("hm-embed-missing")).toBe(true);
    expect(editor.view.dom.querySelector(".hm-card-body")!.textContent).toContain("not available");
    expect(editor.view.dom.querySelector(".hm-card-title")!.textContent).toBe("Plan note");
  });

  it("F2: a ref that starts with a dash is never passed to the command that reads notes", () => {
    for (const ref of ["--help", "-x", "  -x"]) {
      readNote.mockReset();
      const editor = mount([{ type: "noteCard", attrs: { ref, title: "Sneaky" } }], context());
      expect(readNote).not.toHaveBeenCalled();
      expect(editor.view.dom.querySelector(".hm-notecard")!.classList.contains("hm-embed-missing")).toBe(true);
      expect(editor.view.dom.querySelector(".hm-card-title")!.textContent).toBe("Sneaky");
      (editor.view.dom.querySelector(".hm-card-title") as HTMLElement).click();
      expect(openNote).not.toHaveBeenCalled();
    }
  });

  it("a double-click asks to change the note", () => {
    readNote.mockReturnValue(new Promise(() => {}));
    const editor = mount([noteCard], context());
    editor.view.dom.querySelector(".hm-notecard")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(edit).toHaveBeenCalledWith(0);
  });

  it("the lines of a body", () => {
    expect(cardLines("# H\n\n  a  \n\n\n## H2\nb\n```js\nc\n```\nd")).toEqual(["a", "b", "d"]);
    expect(cardLines("x".repeat(300))[0]).toHaveLength(220);
    expect(cardLines("")).toEqual([]);
  });
});

describe("architecture diagram", () => {
  const diagram = { type: "diagram", attrs: { system: "hive", path: "diagrams/c4.svg", title: "C4 overview" } };

  it("draws the picture system_diagram gives, with its title under it", async () => {
    systemDiagram.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
    const editor = mount([diagram], context());
    await settle();
    expect(systemDiagram).toHaveBeenCalledWith("hive", "diagrams/c4.svg");
    const img = editor.view.dom.querySelector(".hm-diagram img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(editor.view.dom.querySelector(".hm-embed-caption")!.textContent).toBe("C4 overview");
  });

  it("a diagram the manifest no longer lists shows a placeholder naming it", async () => {
    systemDiagram.mockRejectedValue(new Error("diagram is not in the manifest"));
    const editor = mount([diagram], context());
    await settle();
    const text = editor.view.dom.querySelector(".hm-diagram")!.textContent!;
    expect(text).toContain("Diagram not found: diagrams/c4.svg (system hive)");
    expect(text).toContain("not in the manifest");
    expect(editor.view.dom.querySelector("img")).toBeNull();
  });
});

describe("code range", () => {
  const text = ["one", "two", "three", "four"].join("\n");
  const stored = captureRange(fileLines(text), 2, 3);
  if (!stored.ok) throw new Error("setup");
  const block = { type: "codeRange", attrs: { file: "src/a.ts", from: 2, to: 3, sha256: stored.captured.sha256, text: stored.captured.text, language: "ts", title: "" } };
  const loaded = (t: string) => ({ text: t, binary: false });
  const badge = (editor: Editor) => editor.view.dom.querySelector(".hm-range-badge") as HTMLElement;
  const update = (editor: Editor) => editor.view.dom.querySelector(".hm-code-range .link") as HTMLButtonElement;
  const shown = (editor: Editor) => editor.view.dom.querySelector(".cm-content")!.textContent;

  it("shows the file's lines when they are the stored ones: no badge, nothing written", async () => {
    const editor = mount([block], context({ read: vi.fn(async () => loaded(text)) as never }));
    let writes = 0;
    editor.on("update", () => { writes++; });
    await settle();
    expect(editor.view.dom.querySelector(".hm-range-label")!.textContent).toBe("src/a.ts:2-3");
    expect(shown(editor)).toBe("twothree");
    expect(badge(editor).hidden).toBe(true);
    expect(update(editor).hidden).toBe(true);
    expect(writes).toBe(0);
  });

  it("a changed range shows the file's current lines with the badge, and Update stores them", async () => {
    const now = text.replace("three", "THREE");
    const editor = mount([block], context({ read: vi.fn(async () => loaded(now)) as never }));
    await settle();
    expect(shown(editor)).toBe("twoTHREE");
    expect(badge(editor).hidden).toBe(false);
    expect(badge(editor).textContent).toBe("Changed since embedded");
    // The page has not changed yet.
    expect(attrsOf(editor).text).toBe("two\nthree");
    expect(update(editor).hidden).toBe(false);
    update(editor).click();
    expect(attrsOf(editor)).toMatchObject({ text: "two\nTHREE", sha256: hashLines(["two", "THREE"]), from: 2, to: 3, file: "src/a.ts" });
    await settle();
    // Drawn again against the same file, the stored lines are now the file's: no badge.
    expect(badge(editor).hidden).toBe(true);
  });

  it("there is no Update on a page that cannot be edited", async () => {
    const editor = mount([block], context({ read: vi.fn(async () => loaded(text.replace("three", "THREE"))) as never }), false);
    await settle();
    expect(badge(editor).hidden).toBe(false);
    expect(update(editor).hidden).toBe(true);
  });

  it("a missing file shows the stored lines and says so", async () => {
    const editor = mount([block], context());
    await settle();
    expect(shown(editor)).toBe("twothree");
    expect(editor.view.dom.querySelector(".hm-code-range .muted.small")!.textContent).toContain("src/a.ts was not found");
    expect(badge(editor).hidden).toBe(true);
  });

  it("a file shorter than the range shows the stored lines and says so", async () => {
    const editor = mount([block], context({ read: vi.fn(async () => loaded("one\ntwo")) as never }));
    await settle();
    expect(shown(editor)).toBe("twothree");
    expect(editor.view.dom.querySelector(".hm-code-range .muted.small")!.textContent).toContain("now has 2 lines");
  });

  it("a page outside a folder notebook shows the stored lines", async () => {
    const editor = mount([block], context(null));
    await settle();
    expect(shown(editor)).toBe("twothree");
  });
});

describe("PDF page", () => {
  const block = { type: "pdfPage", attrs: { file: "docs/My Spec.pdf", page: 4, title: "Spec, section 4" } };

  it("draws the page from the notebook's grant URL", async () => {
    drawPage.mockResolvedValue({ ok: true, pages: 9 });
    const editor = mount([block], context());
    await settle();
    expect(drawPage).toHaveBeenCalledTimes(1);
    const [url, page, canvas] = drawPage.mock.calls[0];
    expect(url).toBe("http://hmfile.localhost/g/docs/My%20Spec.pdf");
    expect(page).toBe(4);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(editor.view.dom.querySelector(".hm-embed-head")!.textContent).toContain("Spec, section 4");
  });

  it("draws when it scrolls into view, once", async () => {
    let seen: ((e: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: typeof seen) { seen = cb; } observe() {} disconnect() {} });
    drawPage.mockResolvedValue({ ok: true, pages: 9 });
    mount([block], context());
    await settle();
    expect(drawPage).not.toHaveBeenCalled();
    seen!([{ isIntersecting: false }]);
    expect(drawPage).not.toHaveBeenCalled();
    seen!([{ isIntersecting: true }]);
    expect(drawPage).toHaveBeenCalledTimes(1);
  });

  it("says why a page could not be drawn", async () => {
    drawPage.mockResolvedValue({ ok: false, reason: "The PDF has 3 pages, so page 4 is not there." });
    const editor = mount([block], context());
    await settle();
    expect(editor.view.dom.querySelector(".hm-pdf")!.textContent).toContain("The PDF has 3 pages, so page 4 is not there.");
  });

  it("a page outside a folder notebook shows a placeholder with the title", () => {
    const editor = mount([block], context(null));
    expect(drawPage).not.toHaveBeenCalled();
    expect(editor.view.dom.querySelector(".hm-embed-missing")!.textContent).toContain("Spec, section 4");
  });
});

describe("gallery", () => {
  const block = { type: "gallery", attrs: { images: ["pics/a.png", "pics/b one.png", "pics/c.jpg"], columns: 2, title: "Screens" } };
  const lightbox = () => document.body.querySelector(".hm-lightbox") as HTMLElement | null;
  const keydown = (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  it("draws a grid of the given columns with each picture from the notebook's grant", () => {
    const editor = mount([block], context());
    const grid = editor.view.dom.querySelector(".hm-gallery-grid") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect([...grid.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      "http://hmfile.localhost/g/pics/a.png", "http://hmfile.localhost/g/pics/b%20one.png", "http://hmfile.localhost/g/pics/c.jpg",
    ]);
    expect(editor.view.dom.querySelector(".hm-embed-caption")!.textContent).toBe("Screens");
  });

  it("a click opens the lightbox on that picture; arrows move, Escape closes", () => {
    const editor = mount([block], context());
    (editor.view.dom.querySelectorAll(".hm-gallery-item")[1] as HTMLElement).click();
    expect(lightbox()).not.toBeNull();
    expect(lightbox()!.querySelector("img")!.getAttribute("src")).toBe("http://hmfile.localhost/g/pics/b%20one.png");
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("2 of 3: b one.png");
    keydown("ArrowRight");
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("3 of 3: c.jpg");
    keydown("ArrowRight");
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("3 of 3: c.jpg");
    keydown("ArrowLeft");
    keydown("ArrowLeft");
    keydown("ArrowLeft");
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("1 of 3: a.png");
    keydown("Escape");
    expect(lightbox()).toBeNull();
    // With the lightbox shut its keys are no longer taken.
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("the buttons move and close it too, and an end's arrow is disabled", () => {
    const editor = mount([block], context());
    (editor.view.dom.querySelectorAll(".hm-gallery-item")[0] as HTMLElement).click();
    const prev = lightbox()!.querySelector(".hm-lightbox-prev") as HTMLButtonElement;
    const next = lightbox()!.querySelector(".hm-lightbox-next") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    next.click();
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("2 of 3: b one.png");
    (lightbox()!.querySelector(".hm-lightbox-close") as HTMLElement).click();
    expect(lightbox()).toBeNull();
  });

  it("a picture that is missing says so, and the others still open", () => {
    const files = context({ url: (p) => (p === "pics/a.png" ? null : `http://hmfile.localhost/g/${p}`) });
    const editor = mount([block], files);
    const items = editor.view.dom.querySelectorAll(".hm-gallery-item");
    expect(items[0].textContent).toContain("Picture not found: pics/a.png");
    (items[1] as HTMLElement).click();
    expect(lightbox()!.querySelector(".hm-lightbox-label")!.textContent).toBe("1 of 2: b one.png");
    keydown("Escape");
  });

  it("a picture that fails to load is replaced by its name", () => {
    const editor = mount([block], context());
    const img = editor.view.dom.querySelector(".hm-gallery-item img")!;
    img.dispatchEvent(new Event("error"));
    expect(editor.view.dom.querySelector(".hm-gallery-item")!.textContent).toContain("Picture not found: pics/a.png");
  });

  it("the keys of the lightbox", () => {
    expect(lightboxKey(1, 3, "ArrowRight")).toEqual({ index: 2, open: true });
    expect(lightboxKey(2, 3, "ArrowRight")).toEqual({ index: 2, open: true });
    expect(lightboxKey(0, 3, "ArrowLeft")).toEqual({ index: 0, open: true });
    expect(lightboxKey(1, 3, "ArrowUp")).toEqual({ index: 0, open: true });
    expect(lightboxKey(1, 3, "ArrowDown")).toEqual({ index: 2, open: true });
    expect(lightboxKey(1, 3, "Home")).toEqual({ index: 0, open: true });
    expect(lightboxKey(1, 3, "End")).toEqual({ index: 2, open: true });
    expect(lightboxKey(1, 3, "Escape")).toEqual({ index: 1, open: false });
    expect(lightboxKey(1, 3, "a")).toBeNull();
    expect(lightboxKey(1, 3, "Enter")).toBeNull();
  });

  it("openLightbox returns the function that closes it and puts the focus back", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = openLightbox([{ url: "http://x/a.png", name: "a.png" }], 0);
    expect(lightbox()).not.toBeNull();
    expect(document.activeElement).toBe(lightbox());
    close();
    expect(lightbox()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("a page outside a folder notebook shows a placeholder", () => {
    const editor = mount([block], context(null));
    expect(editor.view.dom.querySelector(".hm-embed-missing")!.textContent).toContain("Screens");
  });
});

describe("drawing", () => {
  const block = { type: "excalidraw", attrs: { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png", title: "Sketch" } };

  it("draws the preview and an Edit button that asks to edit the block", () => {
    const editor = mount([block], context());
    const img = editor.view.dom.querySelector(".hm-drawing-block img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("http://hmfile.localhost/g/attachments/Sketch.png");
    (editor.view.dom.querySelector(".hm-drawing-edit") as HTMLElement).click();
    expect(edit).toHaveBeenCalledWith(0);
  });

  it("has no Edit button on a page that cannot be edited", () => {
    const editor = mount([block], context(), false);
    expect(editor.view.dom.querySelector(".hm-drawing-edit")).toBeNull();
    expect(editor.view.dom.querySelector(".hm-drawing-block img")).not.toBeNull();
  });

  it("a preview that is missing says so, and the drawing can still be edited", () => {
    const editor = mount([block], context({ url: () => null }));
    expect(editor.view.dom.querySelector(".hm-drawing-block")!.textContent).toContain("Drawing preview not found: attachments/Sketch.png");
    expect(editor.view.dom.querySelector(".hm-drawing-edit")).not.toBeNull();
  });

  it("a preview that fails to load is replaced by the same words", () => {
    const editor = mount([block], context());
    editor.view.dom.querySelector(".hm-drawing-block img")!.dispatchEvent(new Event("error"));
    expect(editor.view.dom.querySelector(".hm-drawing-block")!.textContent).toContain("Drawing preview not found");
  });
});

describe("drawing never writes the page", () => {
  it("a page with every embed, opened, draws and changes nothing", async () => {
    readNote.mockResolvedValue({ title: "T", type: "knowledge", status: "active", body: "x" });
    systemDiagram.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
    drawPage.mockResolvedValue({ ok: true, pages: 2 });
    const editor = mount([
      noteCard,
      { type: "diagram", attrs: { system: "hive", path: "d.svg", title: "" } },
      { type: "codeRange", attrs: { file: "a.ts", from: 1, to: 1, sha256: hashLines(["x"]), text: "y", language: "ts", title: "" } },
      { type: "pdfPage", attrs: { file: "a.pdf", page: 1, title: "" } },
      { type: "gallery", attrs: { images: ["a.png"], columns: 2, title: "" } },
      { type: "excalidraw", attrs: { scene: "a.excalidraw", preview: "a.png", title: "" } },
    ], context({ read: vi.fn(async () => ({ text: "changed", binary: false })) as never }));
    const before = editor.state.doc.toJSON();
    let writes = 0;
    editor.on("update", () => { writes++; });
    await settle();
    await settle();
    expect(writes).toBe(0);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});
