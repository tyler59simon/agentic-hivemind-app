// @vitest-environment jsdom
// The brief's evidence ticks are saves of the whole note body: like the editor's save, they carry the bridge generation the
// brief was read in, so a save made after Hivemind switched to another store is refused.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, Note } from "../../lib/lm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const generation = { now: 5 as number | undefined };
const updates: { ref: string; payload: { body?: string; expected_revision?: string }; opts: { at?: number } | undefined }[] = [];
vi.mock("../../lib/lm", async (original) => ({
  ...(await original<typeof import("../../lib/lm")>()),
  update: vi.fn(async (ref: string, payload: object, opts?: { at?: number }) => { updates.push({ ref, payload, opts }); return { operation_id: "op-1" }; }),
  bridgeGeneration: () => generation.now,
}));

const { Evidence } = await import("./ChangeDetail");

const change = { id: 1, display: "CH-1", title: "T", project: "p", brief: "demo:abc12345", stage: "implement", status: "active" } as unknown as Change;
const note = { id: "abc12345", domain: "demo", title: "Brief", type: "plan", status: "active", tags: [], revision: "rev-1", truncated: false, body: "Summary.\n\n## Acceptance evidence\n- [ ] It works\n" } as Note;

let root: Root | null = null;
beforeEach(() => { updates.length = 0; generation.now = 5; });
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("ticking acceptance evidence", () => {
  it("saves the brief against its revision and the generation it was read in", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><Evidence change={change} note={note} writable /></QueryClientProvider>));
    // Hivemind has moved on to another store since the brief was read.
    generation.now = 6;
    await act(async () => el.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    expect(updates).toEqual([{ ref: "demo:abc12345", payload: { body: "Summary.\n\n## Acceptance evidence\n- [x] It works\n", expected_revision: "rev-1" }, opts: { at: 5 } }]);
  });
});
