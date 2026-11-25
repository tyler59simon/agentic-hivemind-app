// @vitest-environment jsdom
// The graph has no visible title, so it carries a hidden h1 (DESK-A11Y A2): a page of the Notes section has exactly one.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "notebooks_list" || cmd === "index_tags" ? [] : null)) }));
vi.mock("./GraphCanvas", () => ({ GraphCanvas: () => null }));

const { GraphView } = await import("./GraphView");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

it("has one h1, hidden, named Graph", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><GraphView /></QueryClientProvider>));
  const h1 = [...el.querySelectorAll("h1")];
  expect(h1.map((h) => [h.textContent, h.className])).toEqual([["Graph", "visually-hidden"]]);
});
