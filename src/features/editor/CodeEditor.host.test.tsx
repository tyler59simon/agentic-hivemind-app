// @vitest-environment jsdom
// The editor is made once in its host element. Turning the power bar on or off must not make React replace that host, or
// the text disappears: a canvas that cannot be a board first renders with the bar off and then switches to Source (NS-7C UI
// pass, 2026-11-22).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { CodeEditor } = await import("./CodeEditor");

let pane: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  pane = document.createElement("div");
  document.body.append(pane);
  root = createRoot(pane);
});
afterEach(async () => {
  await act(async () => root.unmount());
  pane.remove();
});

const render = (on: boolean) => act(async () => {
  root.render(<CodeEditor doc={'{"nodes":[]}'} docVersion={0} language="text" live={false} readOnly={false} lineNumbers onChange={() => {}}
    onSave={() => {}} titles={() => []} onOpenLink={() => {}} power={{ id: "t1", fileName: "Broken.canvas", on }} />);
});

it("keeps the text when the power bar turns on after the first render", async () => {
  await render(false);
  expect(pane.querySelector(".md-editor .cm-content")?.textContent).toBe('{"nodes":[]}');
  await render(true);
  expect(pane.querySelector(".md-editor .cm-content")?.textContent).toBe('{"nodes":[]}');
  await render(false);
  expect(pane.querySelector(".md-editor .cm-content")?.textContent).toBe('{"nodes":[]}');
});
