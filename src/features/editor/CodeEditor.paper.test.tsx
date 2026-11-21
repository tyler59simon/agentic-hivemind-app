// @vitest-environment jsdom
// Live mode draws Mermaid fences in the colours of the document, and draws them again when the pane's background or the
// theme changes, in the same editor: the text, the cursor and the undo history stay.
import { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RichContext } from "./rich/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
const initialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize: (o: unknown) => initialize(o), render: vi.fn(async () => ({ svg: "<svg></svg>" })) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { CodeEditor } = await import("./CodeEditor");
const { announceDocumentLook } = await import("../../lib/paper");
const { applyTheme } = await import("../../lib/theme");

const rich: RichContext = {
  pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(),
};
const DOC = "Intro line\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nEnd";
const themes = () => initialize.mock.calls.map((c) => (c[0] as { theme: string }).theme);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
let pane: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  initialize.mockClear();
  applyTheme("purple", false);
  pane = document.createElement("div");
  document.body.append(pane);
  root = createRoot(pane);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const mount = async () => {
  await act(async () => root.render(
    <CodeEditor doc={DOC} docVersion={0} language="markdown" live readOnly={false} lineNumbers={false} onChange={() => {}} onSave={() => {}}
      titles={() => []} onOpenLink={() => {}} rich={rich} />));
  await settle();
  return EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-content")!)!;
};

describe("a rich Live editor", () => {
  it("draws its diagrams dark under a dark theme, light inside a white pane", async () => {
    await mount();
    expect(themes()).toEqual(["dark"]);
    await act(async () => root.unmount());
    root = createRoot(pane);
    initialize.mockClear();
    pane.setAttribute("data-paper", "");
    await mount();
    expect(themes()).toEqual(["default"]);
  });

  it("draws them again when the pane turns white, keeping the editor, its text, cursor and undo history", async () => {
    const view = await mount();
    act(() => { view.dispatch({ changes: { from: 0, insert: "typed " }, selection: { anchor: 3 }, userEvent: "input.type" }); });
    const text = view.state.doc.toString();
    expect(undoDepth(view.state)).toBe(1);
    expect(themes()).toEqual(["dark"]);
    pane.setAttribute("data-paper", "");
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
    const after = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-content")!)!;
    expect(after).toBe(view);
    expect(after.state.doc.toString()).toBe(text);
    expect(after.state.selection.main.head).toBe(3);
    expect(undoDepth(after.state)).toBe(1);
    pane.removeAttribute("data-paper");
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark", "default", "dark"]);
  });

  it("follows a theme change when it is not in a white pane", async () => {
    await mount();
    await act(async () => applyTheme("emerald-light", false));
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
  });

  it("does nothing for an announcement that changes nothing", async () => {
    await mount();
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark"]);
  });
});
