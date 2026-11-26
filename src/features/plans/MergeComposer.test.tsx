// @vitest-environment jsdom
// Codex review of e30902f, S1 and D1. A stale merge keeps the user's edited text: they merge it over the notes as they are
// now, or make it again from them. A note longer than Living Memory's read limit is never merged from the part that was read.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const lm = await import("../../lib/lm");
const { MergeComposer } = await import("./MergeComposer");

const notes: Record<string, { id: string; title: string; body: string; revision: string; truncated: boolean }> = {};
const merges: { target: string; sources: string[]; body: string }[] = [];
let stale = false;
beforeEach(() => {
  notes["d:t"] = { id: "t", title: "Target", body: "Target body.", revision: "t1", truncated: false };
  notes["d:s"] = { id: "s", title: "Source", body: "Source summary.", revision: "s1", truncated: false };
  merges.length = 0;
  stale = false;
});
lm.setTransport(async (_cmd, args) => {
  const { argv, stdin } = args as { argv: string[]; stdin: string | null };
  if (argv[0] === "read") return { exit_code: 0, error: null, result: { domain: "d", type: "knowledge", status: "active", tags: [], ...notes[argv[1]] } };
  if (argv[0] === "merge") {
    merges.push(JSON.parse(stdin!));
    if (stale) return { exit_code: 6, result: null, error: { code: "stale", message: "stale_revision: d:t changed since revision t1; read it again and redo the change" } };
    return { exit_code: 0, error: null, result: { ok: true, operation_id: "m-1", state: "committed", kind: "merge", undo: "undo m-1" } };
  }
  return { exit_code: 0, error: null, result: {} };
});

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const textarea = () => document.querySelector<HTMLTextAreaElement>("textarea.merge-body");
const type = (el: HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

async function open() {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}>
    <MergeComposer source={{ ref: "d:s", title: "Source" }} target={{ ref: "d:t", title: "Target" }} onClose={() => {}} />
  </QueryClientProvider>));
  await settle();
}

describe("the merge composer after a stale refusal", () => {
  it("keeps the edited text, and sends it with the new revisions once the user keeps it", async () => {
    await open();
    await type(textarea()!, "My own merged paragraph.");
    stale = true;
    Object.assign(notes["d:t"], { body: "Target body, edited by an agent.", revision: "t2" });
    await act(async () => button("Merge")!.click());
    await settle();
    expect(textarea()!.value).toBe("My own merged paragraph.");
    expect(button("Merge")!.disabled).toBe(true);
    expect(document.querySelector(".warn-text")?.textContent).toMatch(/^This note changed; reloaded\. Your merged text is kept\./);
    // Codex re-review, N01: what the agent changed is shown before the user keeps their text over it.
    expect([...document.querySelectorAll(".diff .diff-line.del")].map((l) => l.textContent?.trim())).toEqual(["-Target body."]);
    expect([...document.querySelectorAll(".diff .diff-line.add")].map((l) => l.textContent?.trim())).toEqual(["+Target body, edited by an agent."]);

    stale = false;
    await act(async () => button("Keep my text")!.click());
    await act(async () => button("Merge")!.click());
    await settle();
    expect(merges[1]).toEqual({ target: "d:t@t2", sources: ["d:s@s1"], body: "My own merged paragraph." });
  });

  it("makes the text again only when the user asks", async () => {
    await open();
    await type(textarea()!, "My own merged paragraph.");
    stale = true;
    Object.assign(notes["d:t"], { body: "Target body, edited by an agent.", revision: "t2" });
    await act(async () => button("Merge")!.click());
    await settle();
    await act(async () => button("Make it again")!.click());
    expect(textarea()!.value).toBe("Target body, edited by an agent.\n\n## Merged from Source\nSource summary.");
  });
});

describe("a note longer than the read limit", () => {
  it("blocks the merge when the target was cut off", async () => {
    notes["d:t"].truncated = true;
    await open();
    expect(textarea()).toBeNull();
    expect(document.querySelector(".error")?.textContent).toMatch(/“Target” is longer than the 64,000 characters Hivemind can read/);
    expect(button("Merge")!.disabled).toBe(true);
    expect(merges).toEqual([]);
  });

  it("blocks the merge when the source was cut off", async () => {
    notes["d:s"].truncated = true;
    await open();
    expect(button("Merge")!.disabled).toBe(true);
  });

  it("blocks the merge when the reread after a stale refusal is cut off", async () => {
    await open();
    stale = true;
    Object.assign(notes["d:t"], { revision: "t2", truncated: true });
    await act(async () => button("Merge")!.click());
    await settle();
    expect(textarea()).toBeNull();
    expect(button("Merge")!.disabled).toBe(true);
    expect(merges).toHaveLength(1);
  });
});
