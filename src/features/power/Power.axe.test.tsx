// @vitest-environment jsdom
// DESKA2-MENU (WCAG 2.5.3, Label in Name): the strip above a text file's editor and the status line below it have menu buttons
// that show text. Each one's name holds that text, and axe finds nothing else wrong with either.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocState } from "../../documents/session";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../documents/store", () => ({ reformat: vi.fn(), reopenAs: vi.fn() }));
vi.mock("./language", async (original) => ({
  ...(await original<object>()),
  describe: async () => ({ name: "TypeScript" }),
  languageList: async () => [{ name: "TypeScript" }, { name: "Rust" }],
}));

const { PowerBar } = await import("./PowerBar");
const { StatusLine } = await import("./StatusLine");

let root: Root | null = null;
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const doc = (eol: "lf" | "crlf" = "crlf"): DocState => ({
  status: "clean", text: "a\n  b\n", version: 1,
  base: { text: "a\n  b\n", stamp: { sha256: "x", size: 7, mtimeMs: 1 }, format: { encoding: "UTF-8", bom: false, eol, confidence: "valid" }, readOnly: null, binary: false },
});
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button.menu-button")];
/** The name a screen reader gives the button: its `aria-label`, else its text. */
const nameOf = (b: HTMLElement) => b.getAttribute("aria-label") ?? b.textContent ?? "";

describe("the power bar", () => {
  it("names its text menu buttons by their text", async () => {
    await mount(<PowerBar view={() => null} readOnly={false} />);
    expect(buttons().map((b) => [b.textContent, nameOf(b)])).toEqual([["Lines", "Lines"], ["Macro", "Macro"]]);
  });

  it("has no axe violations, with Label in Name checked", async () => {
    await mount(<PowerBar view={() => null} readOnly={false} />);
    await expectNoNewAxeViolations(document.body, []);
  });
});

describe("the status line", () => {
  const status = (d: DocState) => <StatusLine doc={d} docKey="k" tabId="t" fileName="a.ts" markdown={false} onLanguage={() => {}} />;

  it("starts each menu button's name with the value it shows", async () => {
    await mount(status(doc()));
    const shown = buttons().map((b) => [b.textContent, nameOf(b)]);
    expect(shown).toEqual([
      ["UTF-8", "UTF-8, encoding"],
      ["CRLF", "CRLF, line endings"],
      ["2 spaces", "2 spaces, indentation"],
      ["TypeScript", "TypeScript, language"],
    ]);
    for (const b of buttons()) expect(nameOf(b).startsWith(b.textContent!)).toBe(true);
  });

  it("has no axe violations, with Label in Name checked", async () => {
    await mount(status(doc("lf")));
    await expectNoNewAxeViolations(document.body, []);
  });
});
