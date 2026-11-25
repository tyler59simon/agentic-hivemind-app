// @vitest-environment jsdom
// The Skills pane's title is its one h1 (DESK-A11Y A2), with the skill's own name an h2 below it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { SkillsPane } = await import("./SkillsPane");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

it("has one h1, Skills", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SkillsPane /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect([...el.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Skills"]);
  expect(el.querySelector("h1")!.closest(".skills-pane > .section-head")).not.toBeNull();
});
