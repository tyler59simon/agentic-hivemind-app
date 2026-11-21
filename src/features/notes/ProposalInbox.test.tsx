// @vitest-environment jsdom
// Codex re-review of 75ce884, R2-T2: the proposal inbox mounted, merging an agent's edit. The merge is sent as one
// `doc accept --edited` against the revision shown; when Living Memory refuses it (the page changed meanwhile, or any
// other failure) nothing closes, and the merge stays in its dialog (Codex review of 32fee20, D3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
// CodeMirror does not run in jsdom: the merge dialog resolves to a fixed merge, and the diff draws nothing.
vi.mock("../editor/MergeDialog", () => ({
  PageMergeDialog: ({ onResolve, onCancel, noun }: { onResolve: (text: string) => void; onCancel: () => void; noun?: string }) => (
    <div data-merge="" data-noun={noun}><button onClick={() => onResolve("merged\n")}>Use this merge</button><button onClick={onCancel}>Cancel merge</button></div>
  ),
}));
vi.mock("../review/CodeDiff", () => ({ CodeDiff: () => null }));
const toasts = vi.hoisted(() => [] as { text: string; kind?: string }[]);
vi.mock("../../ui/toast", () => ({ toast: (text: string, kind?: string) => { toasts.push({ text, kind }); }, Toasts: () => null }));

const { setTransport } = await import("../../lib/lm");
const { useConnection } = await import("../../lib/connection");
const { ProposalInbox } = await import("./ProposalInbox");
type Invoke = Parameters<typeof setTransport>[0];

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

let root: Root | null = null;
beforeEach(() => {
  toasts.length = 0;
  useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, max_asset_bytes: 1, accept_edited: true } } });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  setTransport(invoke as Invoke);
  useConnection.setState({ commands: [], capabilities: undefined });
});

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  expect(ok()).toBe(true);
}
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);

/** The inbox of lm:demo:plans with one proposal to A.md made against the page as it is; `merged` answers the merge. */
async function inbox(merged: { exit_code: number; error: unknown }) {
  const page = "one\n", rev = await sha(page);
  const row = { id: "p1", domain: "demo", notebook: "plans", path: "A.md", base_revision: rev, note: null, created: new Date().toISOString(), status: "pending" };
  const sent: { cmd: string; argv: string[]; body?: unknown }[] = [];
  setTransport(async (cmd, a) => {
    const argv = a.argv as string[];
    sent.push({ cmd, argv, body: a.body });
    const ok = (result: unknown) => ({ exit_code: 0, result, error: null });
    if (cmd === "lm_body") return { ...merged, result: null };
    if (argv[1] === "proposals") return ok({ proposals: [row] });
    if (argv[1] === "proposal") return ok({ proposal: { ...row, body: "two\n", session: "s1" } });
    if (argv[1] === "read") return ok({ text: page, revision: rev, size: page.length, updated: "2026-11-21T00:00:00Z", truncated: false });
    return { exit_code: 2, result: null, error: { code: "invalid", message: `not served here: ${argv.join(" ")}` } };
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const nb = { domain: "demo", notebook: "plans", title: "Plans", visibility: "searchable", private: false, pages: 1, assets: 0 } as never;
  await act(async () => root!.render(<QueryClientProvider client={client}><ProposalInbox nb={nb} onClose={() => {}} /></QueryClientProvider>));
  await until(() => !!button("A.md"));
  await act(async () => button("A.md")!.click());
  await until(() => !!button("Edit, then accept…"));
  await act(async () => button("Edit, then accept…")!.click());
  await until(() => !!document.querySelector("[data-merge]"));
  await act(async () => button("Use this merge")!.click());
  return { sent, rev };
}

describe("merging an agent's proposal in the inbox", () => {
  it("a merge refused because the page changed meanwhile keeps its dialog open, and is one doc accept --edited", async () => {
    const { sent, rev } = await inbox({ exit_code: 6, error: { code: "stale", message: "Stale revision" } });
    await until(() => toasts.some((t) => t.kind === "warn"));
    expect(document.querySelector("[data-merge]")).not.toBeNull();
    // The dialog is worded for an agent's proposal, not for a page that changed on disk (NS-2C UI pass).
    expect(document.querySelector("[data-merge]")?.getAttribute("data-noun")).toBe("proposal");
    const merges = sent.filter((s) => s.cmd === "lm_body");
    expect(merges).toEqual([{ cmd: "lm_body", argv: ["doc", "accept", "--edited", "--expected-revision", rev, "--include-private", "--", "p1"], body: "merged\n" }]);
    expect(sent.some((s) => s.argv[1] === "write" || s.argv[1] === "reject")).toBe(false);
  });

  it("a merge that fails for another reason keeps its dialog open too", async () => {
    await inbox({ exit_code: 1, error: { code: "internal", message: "The store is locked" } });
    await until(() => toasts.some((t) => t.kind === "error"));
    expect(toasts.find((t) => t.kind === "error")?.text).toMatch(/locked/);
    expect(document.querySelector("[data-merge]")).not.toBeNull();
  });
});
