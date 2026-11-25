// @vitest-environment jsdom
// Spell checking in the Markdown editors (DESK-8): on for prose, off in code, off for text files and when turned off in
// Settings, and an open editor follows the setting. What the browser then underlines needs the running app.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { CodeEditor } = await import("./CodeEditor");
const { noSpellInCode } = await import("./noSpellInCode");
const { setSpellcheck } = await import("../../lib/spellcheck");
type Props = Parameters<typeof CodeEditor>[0];

const DOC = [
  "Plain prose here.", "", "```js", "const x = 1;", "```", "", "    indented code", "",
  "Text with `inline` code, https://example.com/a and [[Some Page#Head|nice alias]], [[Other Page]] end.",
].join("\n");

let pane: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  setSpellcheck(true);
  pane = document.createElement("div");
  document.body.append(pane);
  root = createRoot(pane);
});
afterEach(async () => {
  await act(async () => root.unmount());
  pane.remove();
  localStorage.clear();
});

const base: Props = {
  doc: DOC, docVersion: 0, language: "markdown", live: false, readOnly: false, lineNumbers: false,
  onChange: () => {}, onSave: () => {}, titles: () => [], onOpenLink: () => {},
};
const render = (over: Partial<Props> = {}) => act(async () => { root.render(<CodeEditor {...base} {...over} />); });
const content = () => pane.querySelector<HTMLElement>(".cm-content")!;
const lines = () => [...pane.querySelectorAll<HTMLElement>(".cm-line")];
const lineOff = (text: string) => lines().find((l) => l.textContent?.includes(text))!.getAttribute("spellcheck");
const spans = () => [...pane.querySelectorAll<HTMLElement>('span[spellcheck="false"]')].map((s) => s.textContent);
/** Whether the browser would skip this text: it or an ancestor inside the editor says spellcheck="false". */
const skipped = (text: string) => {
  const walker = document.createTreeWalker(content(), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.nodeValue!.indexOf(text);
    if (at >= 0) return n.parentElement!.closest('[spellcheck="false"]') !== null;
  }
  throw new Error(`no text "${text}"`);
};

describe("the editor's attribute", () => {
  it("a Markdown editor checks spelling and turns off the keyboard's own corrections", async () => {
    await render();
    expect(content().getAttribute("spellcheck")).toBe("true");
    expect(content().getAttribute("autocorrect")).toBe("off");
    expect(content().getAttribute("autocapitalize")).toBe("off");
  });

  it("a text file does not", async () => {
    await render({ language: "text" });
    expect(content().getAttribute("spellcheck")).toBe("false");
  });

  it("an open editor follows the Settings choice", async () => {
    await render();
    await act(async () => setSpellcheck(false));
    expect(content().getAttribute("spellcheck")).toBe("false");
    expect(spans()).toEqual([]);
    await act(async () => setSpellcheck(true));
    expect(content().getAttribute("spellcheck")).toBe("true");
    expect(skipped("const x")).toBe(true);
  });

  it("an editor opened while the setting is off does not check", async () => {
    setSpellcheck(false);
    await render();
    expect(content().getAttribute("spellcheck")).toBe("false");
    expect(lineOff("const x")).toBeNull();
  });
});

describe("code stays unchecked", () => {
  // Live hides the page name when a link has an alias, so that is checked in Source only.
  const rules = (live: boolean) => {
    expect(skipped("Plain prose")).toBe(false);
    expect(skipped("Text with")).toBe(false);
    expect(skipped("end.")).toBe(false);
    expect(lineOff("```js")).toBe("false");
    expect(lineOff("const x")).toBe("false");
    expect(lineOff("indented code")).toBe("false");
    expect(skipped("inline")).toBe(true);
    expect(skipped("https://example.com/a")).toBe(true);
    if (!live) expect(skipped("Some Page")).toBe(true);
    expect(skipped("Other Page")).toBe(true);
    expect(skipped("nice alias")).toBe(false);
  };

  it("in Source", async () => { await render(); rules(false); });
  it("in Live", async () => { await render({ live: true }); rules(true); });

  it("in a notebook page's rich Live, next to the fence styling", async () => {
    const rich = {
      pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: () => {}, openHref: () => {}, fail: () => {},
    };
    await render({ live: true, rich });
    const fence = lines().find((l) => l.textContent?.includes("const x"))!;
    expect(fence.classList.contains("cm-rich-fence")).toBe(true);
    rules(true);
  });
});

describe("what is marked", () => {
  it("the decorations cover the fence, the indented block, inline code, the URL and the page name, and nothing else", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: DOC, extensions: [markdown({ base: markdownLanguage }), noSpellInCode] }) });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ effects: [] });
    expect(syntaxTree(view.state).length).toBe(DOC.length);
    const found: string[] = [], onLines: string[] = [];
    view.plugin(noSpellInCode)!.decorations.between(0, DOC.length, (from, to, deco) => {
      if (deco.spec.attributes?.spellcheck !== "false") throw new Error("unexpected decoration");
      if (from === to) onLines.push(view.state.doc.lineAt(from).text);
      else found.push(DOC.slice(from, to));
    });
    expect(onLines).toEqual(["```js", "const x = 1;", "```", "    indented code"]);
    expect(found).toEqual(["`inline`", "https://example.com/a", "Some Page", "Other Page"]);
    view.destroy();
    parent.remove();
  });
});
