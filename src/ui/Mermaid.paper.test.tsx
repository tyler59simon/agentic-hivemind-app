// @vitest-environment jsdom
// A diagram draws in the colours of the document it is in, and draws again when the pane's background or the theme changes.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialize = vi.fn();
const render = vi.fn(async (id: string, _source: string, _box: unknown) => ({ svg: `<svg id="${id}"></svg>` }));
vi.mock("mermaid", () => ({ default: { initialize: (o: unknown) => initialize(o), render: (id: string, src: string, box: unknown) => render(id, src, box) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { Mermaid } = await import("./Mermaid");
const { announceDocumentLook } = await import("../lib/paper");
const { applyTheme } = await import("../lib/theme");

const themes = () => initialize.mock.calls.map((c) => (c[0] as { theme: string }).theme);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
let pane: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  initialize.mockClear();
  render.mockClear();
  applyTheme("purple", false);
  pane = document.createElement("div");
  document.body.append(pane);
  root = createRoot(pane);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  applyTheme("purple", false);
});

const draw = async () => { await act(async () => root.render(<Mermaid source={"flowchart LR\n  a --> b"} />)); await settle(); };

describe("Mermaid in a document", () => {
  it("draws dark under a dark theme and light under the light theme, outside a white pane", async () => {
    await draw();
    expect(themes()).toEqual(["dark"]);
    await act(async () => applyTheme("emerald-light", false));
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
  });

  it("draws light inside a white pane under every theme", async () => {
    for (const theme of ["purple", "emerald", "emerald-light"] as const) {
      initialize.mockClear();
      applyTheme(theme, false);
      pane.setAttribute("data-paper", "");
      await draw();
      expect([theme, themes()]).toEqual([theme, ["default"]]);
      await act(async () => root.render(null));
    }
  });

  it("draws again, with no new mount, when the pane turns white or back", async () => {
    await draw();
    expect(themes()).toEqual(["dark"]);
    const picture = pane.querySelector(".mermaid-diagram");
    expect(picture).not.toBeNull();
    pane.setAttribute("data-paper", "");
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark", "default"]);
    expect(pane.querySelector(".mermaid-diagram")).not.toBeNull();
    pane.removeAttribute("data-paper");
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark", "default", "dark"]);
  });

  it("does not draw again for an announcement that changes nothing", async () => {
    await draw();
    await act(async () => announceDocumentLook());
    await settle();
    expect(themes()).toEqual(["dark"]);
  });
});
