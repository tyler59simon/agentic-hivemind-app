// @vitest-environment jsdom
// Rich pages draw Mermaid previews and code ranges in the colours of the document they are in, and again when
// the pane's background or the theme changes, in the same editor.
import { Editor } from "@tiptap/core";
import { EditorView as CodeView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "../editor/rich/context";

const initialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize: (o: unknown) => initialize(o), render: vi.fn(async () => ({ svg: "<svg></svg>" })) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../lib/lm", () => ({ read: vi.fn() }));
vi.mock("../../lib/architecture", () => ({ systemDiagram: vi.fn() }));
vi.mock("../../workspace/store", () => ({ useWorkspace: { getState: () => ({ openNote: vi.fn() }) } }));
vi.mock("../hmdoc/blocks/pdf", () => ({ drawPage: vi.fn() }));
vi.mock("../review/language", () => ({ loadLanguage: vi.fn(async () => null) }));

Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const { withViews } = await import("./views");
const { withEmbedViews } = await import("../hmdoc/blocks/embedViews");
const { hmdocExtensions } = await import("../hmdoc/schema");
const { captureRange, fileLines } = await import("../hmdoc/blocks/codeRange");
const { announceDocumentLook } = await import("../../lib/paper");
const { applyTheme } = await import("../../lib/theme");

const ctx: RichContext = { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn() };
const settle = () => new Promise<void>((r) => setTimeout(r, 20));
const themes = () => initialize.mock.calls.map((c) => (c[0] as { theme: string }).theme);
const editors: Editor[] = [];
let pane: HTMLElement;

function mount(blocks: unknown[]) {
  const element = document.createElement("div");
  pane.append(element);
  const env = { ctx: () => ctx, edit: vi.fn() };
  const editor = new Editor({ element, extensions: withEmbedViews(withViews(hmdocExtensions(), env), env), content: { type: "doc", content: blocks } as never });
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  initialize.mockClear();
  applyTheme("purple", false);
  pane = document.createElement("div");
  document.body.append(pane);
});
afterEach(() => { editors.splice(0).forEach((e) => e.destroy()); document.body.innerHTML = ""; });

const mermaid = { type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: "flowchart LR\n  A --> B" }] };

describe("a Mermaid preview in the rich editor", () => {
  it("draws dark under a dark theme and light inside a white pane", async () => {
    mount([mermaid]);
    await settle();
    expect(themes()).toEqual(["dark"]);
    initialize.mockClear();
    const white = document.createElement("div");
    white.setAttribute("data-paper", "");
    document.body.append(white);
    pane = white;
    mount([mermaid]);
    await settle();
    expect(themes()).toEqual(["default"]);
  });

  it("draws again when the pane turns white and back, without rebuilding the editor", async () => {
    const editor = mount([mermaid]);
    await settle();
    const view = editor.view;
    const text = editor.state.doc.textContent;
    pane.setAttribute("data-paper", "");
    announceDocumentLook();
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
    pane.removeAttribute("data-paper");
    announceDocumentLook();
    await settle();
    expect(themes()).toEqual(["dark", "default", "dark"]);
    expect(editor.view).toBe(view);
    expect(editor.state.doc.textContent).toBe(text);
  });

  it("follows a theme change outside a white pane, and not inside one", async () => {
    mount([mermaid]);
    await settle();
    applyTheme("emerald-light", false);
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
    initialize.mockClear();
    pane.setAttribute("data-paper", "");
    announceDocumentLook();
    await settle();
    expect(themes()).toEqual([]);
    applyTheme("purple", false);
    await settle();
    expect(themes()).toEqual([]);
  });

  it("does not draw again for an announcement that changes nothing", async () => {
    mount([mermaid]);
    await settle();
    announceDocumentLook();
    await settle();
    expect(themes()).toEqual(["dark"]);
  });
});

describe("a code range embed", () => {
  const stored = captureRange(fileLines("one\ntwo\nthree"), 2, 3);
  if (!stored.ok) throw new Error("setup");
  const block = { type: "codeRange", attrs: { file: "src/a.ts", from: 2, to: 3, sha256: stored.captured.sha256, text: stored.captured.text, language: "ts", title: "" } };
  const darkOf = (editor: Editor) => CodeView.findFromDOM(editor.view.dom.querySelector<HTMLElement>(".hm-range-code .cm-editor .cm-content")!)!.state.facet(CodeView.darkTheme);

  it("takes its theme from the document it is in, and from the pane when that changes", async () => {
    const editor = mount([block]);
    await settle();
    expect(darkOf(editor)).toBe(true);
    pane.setAttribute("data-paper", "");
    announceDocumentLook();
    expect(darkOf(editor)).toBe(false);
    pane.removeAttribute("data-paper");
    announceDocumentLook();
    expect(darkOf(editor)).toBe(true);
  });

  it("is light from the start inside a white pane, whatever the theme", async () => {
    for (const theme of ["purple", "emerald", "emerald-light"] as const) {
      applyTheme(theme, false);
      pane = document.createElement("div");
      pane.setAttribute("data-paper", "");
      document.body.append(pane);
      const editor = mount([block]);
      await settle();
      expect([theme, darkOf(editor)]).toEqual([theme, false]);
    }
  });

  it("follows the theme outside a white pane", async () => {
    const editor = mount([block]);
    await settle();
    applyTheme("emerald-light", false);
    expect(darkOf(editor)).toBe(false);
  });
});
