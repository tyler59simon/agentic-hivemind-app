// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

const openUrl = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const renderSpy = vi.fn(async (source: string, _dark: boolean) => {
  if (source.includes("BROKEN")) return { ok: false as const, error: "Parse error on line 2" };
  return { ok: true as const, svg: `<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><text>${source.slice(0, 12)}</text></a></svg>` };
});

vi.mock("../../ui/Mermaid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/Mermaid")>();
  return { ...actual, renderMermaid: (s: string, d: boolean) => renderSpy(s, d) };
});

const { default: MermaidEditor } = await import("./MermaidEditor");
const { NEW_MERMAID_TEXT } = await import("./starter");

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  renderSpy.mockClear();
  openUrl.mockClear();
});

async function until(check: () => unknown) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error("timed out");
}

describe("MermaidEditor", () => {
  it("renders a diagram in preview mode, intercepts link clicks, and never creates an iframe", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        <MermaidEditor doc={NEW_MERMAID_TEXT} docVersion={1} mode="preview" readOnly={false} fileName="flow.mmd" tabId="t1"
          onChange={() => {}} onSave={() => {}} titles={() => []} onOpenLink={() => {}} />,
      );
    });
    await until(() => el.querySelector(".mermaid-diagram svg"));
    expect(document.querySelector("iframe")).toBeNull();
    const link = el.querySelector(".mermaid-diagram a") as Element;
    await act(async () => { link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("keeps the last valid SVG dimmed when a syntax error occurs mid-edit", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        <MermaidEditor doc={NEW_MERMAID_TEXT} docVersion={1} mode="preview" readOnly={false} fileName="flow.mmd" tabId="t1"
          onChange={() => {}} onSave={() => {}} titles={() => []} onOpenLink={() => {}} />,
      );
    });
    await until(() => el.querySelector(".mermaid-diagram svg"));
    await act(async () => {
      root!.render(
        <MermaidEditor doc="BROKEN" docVersion={1} mode="preview" readOnly={false} fileName="flow.mmd" tabId="t1"
          onChange={() => {}} onSave={() => {}} titles={() => []} onOpenLink={() => {}} />,
      );
    });
    await until(() => el.textContent?.includes("Parse error on line 2"));
    expect(el.querySelector(".mermaid-diagram.stale-preview svg")).not.toBeNull();
  });
});
