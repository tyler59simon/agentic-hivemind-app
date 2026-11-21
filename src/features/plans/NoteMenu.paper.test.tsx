// @vitest-environment jsdom
// The page menu of a memory note offers the paper switch for its tab: White background, or Theme background when it is
// already white. Without a tab to switch (no `paper` prop) the item is not there.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../viewer/NoteView", () => ({
  noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: async () => ({ title: "T", type: "knowledge", status: "active" }) }),
}));

const { NoteMenu } = await import("./NoteMenu");

let root: ReturnType<typeof createRoot> | null = null;
async function open(paper?: { white: boolean; flip: () => void }) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><NoteMenu refId="d:1" paper={paper} /></QueryClientProvider>));
  await act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Note actions"]')!.click());
  return () => [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the note menu's paper item", () => {
  it("says White background for a tab on the theme, and flips the tab when chosen", async () => {
    const flip = vi.fn();
    const items = await open({ white: false, flip });
    const labels = items().map((b) => b.textContent);
    expect(labels).toContain("White background");
    expect(labels).not.toContain("Theme background");
    await act(async () => items().find((b) => b.textContent === "White background")!.click());
    expect(flip).toHaveBeenCalledTimes(1);
  });

  it("says Theme background for a tab on white paper", async () => {
    const items = await open({ white: true, flip: vi.fn() });
    const labels = items().map((b) => b.textContent);
    expect(labels).toContain("Theme background");
    expect(labels).not.toContain("White background");
  });

  it("has no item without a tab to switch", async () => {
    const items = await open();
    const labels = items().map((b) => b.textContent);
    expect(labels).not.toContain("White background");
    expect(labels).not.toContain("Theme background");
  });
});
