// @vitest-environment jsdom
// A proposal for a folder notebook's page (CON-9), mounted as the Inbox does: it reads the page through Hivemind's file service,
// merges against the base the proposal kept, and keeps the page's file history around the accept. The merge is sent as one
// `proposals accept --edited` against the revision shown; when Living Memory refuses it (the page changed meanwhile, or any
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
  PageMergeDialog: ({ onResolve, onCancel, noun, base, mine, theirs }: { onResolve: (text: string) => void; onCancel: () => void; noun?: string; base?: string; mine?: string; theirs?: string }) => (
    <div data-merge="" data-noun={noun} data-base={base} data-mine={mine} data-theirs={theirs}><button onClick={() => onResolve("merged\n")}>Use this merge</button><button onClick={onCancel}>Cancel merge</button></div>
  ),
}));
vi.mock("../review/CodeDiff", () => ({ CodeDiff: () => null }));
const toasts = vi.hoisted(() => [] as { text: string; kind?: string }[]);
vi.mock("../../ui/toast", () => ({ toast: (text: string, kind?: string) => { toasts.push({ text, kind }); }, Toasts: () => null }));

const order = vi.hoisted(() => [] as string[]);
// Open tabs read a page again through `refresh`: the order of the accept's steps includes it.
vi.mock("../../documents/store", async (orig) => ({ ...(await orig<object>()), refresh: async () => { order.push("refresh"); } }));

const { setTransport } = await import("../../lib/lm");
const { useConnection } = await import("../../lib/connection");
const { ProposalDetail } = await import("./ProposalInbox");
type Invoke = Parameters<typeof setTransport>[0];

let root: Root | null = null;
beforeEach(() => {
  toasts.length = 0;
  useConnection.setState({ commands: ["doc"], capabilities: { docs: { version: 1, max_page_bytes: 1, accept_edited: true } } });
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

/** A proposal of a page in the folder notebook C:/Users/me/Wiki, shown through ProposalDetail. `books` is what Hivemind's notebook list
 *  holds; `page` is the file service's answer for A.md (null: not there). Every call is kept in `calls`, and the steps of the accept in `order`. */
async function folderInbox(o: { books: unknown[]; page: { text: string; sha256: string } | null; accept?: { exit_code: number; error: unknown }; orphaned?: boolean; base?: string | null }) {
  const row = {
    id: "0123456789ab", domain: "demo", notebook: "nb-0123456789", path: "A.md", base_revision: "r1", note: null, created: new Date().toISOString(), status: "pending",
    reason: null, settled: null, size: 4, folder: "C:/Users/me/Wiki", file: "C:/Users/me/Wiki/A.md", orphaned: !!o.orphaned, applied: false,
  };
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  order.length = 0;
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (cmd === "notebooks_list") return o.books;
    if (cmd === "file_read") {
      if (!o.page) throw "The page does not exist";
      return { ...o.page, size: o.page.text.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
    }
    if (cmd === "history_snapshot") { order.push(`snapshot:${(args as { source: string }).source}`); return null; }
    return null;
  });
  const ok = (result: unknown) => ({ exit_code: 0, result, error: null });
  setTransport(async (cmd, a) => {
    const argv = a.argv as string[];
    calls.push({ cmd, args: a });
    if (argv[0] === "proposals" && argv[1] === "show") return ok({ proposal: { ...row, body: "two\n", session: "s1", base: o.base === undefined ? btoa("one\n") : o.base } });
    if (argv[0] === "proposals" && argv[1] === "accept") { order.push("accept"); return o.accept ? { ...o.accept, result: null } : ok({ operation_id: "doc-1", revision: "r2" }); }
    if (argv[0] === "proposals" && argv[1] === "reject") { order.push("reject"); return ok({ operation_id: "doc-2" }); }
    if (argv[0] === "doc" && argv[1] === "read") { return ok({ domain: "demo", notebook: "nb-0123456789", path: "A.md", text: "from living memory\n", revision: "r1", size: 19, updated: "2026-11-21T00:00:00Z" }); }
    return { exit_code: 2, result: null, error: { code: "invalid", message: `not served here: ${argv.join(" ")}` } };
  });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}><ProposalDetail row={row as never} onSettled={() => order.push("settled")} /></QueryClientProvider>));
  return { calls };
}
const wiki = { id: "nb-1", path: "C:\\Users\\me\\Wiki", title: "Team wiki", added: "" };

describe("a proposal for a page of a folder notebook", () => {
  it("reads the page through Hivemind's file service and keeps its history around the accept: snapshot, accept, snapshot, refresh", async () => {
    const { calls } = await folderInbox({ books: [wiki], page: { text: "one\n", sha256: "r1" } });
    await until(() => !!button("Accept"));
    expect(calls.filter((c) => c.cmd === "file_read").map((c) => c.args)).toEqual([{ notebook: "nb-1", path: "A.md" }]);
    expect(calls.some((c) => c.cmd === "lm" && (c.args.argv as string[])[1] === "read")).toBe(false);
    await act(async () => button("Accept")!.click());
    await until(() => order.includes("settled"));
    expect(order).toEqual(["snapshot:disk", "accept", "snapshot:agent", "refresh", "settled"]);
    expect(calls.filter((c) => c.cmd === "history_snapshot").map((c) => c.args)).toEqual([
      { notebook: "nb-1", path: "A.md", expect: "r1", source: "disk" }, { notebook: "nb-1", path: "A.md", expect: null, source: "agent" },
    ]);
    expect(calls.find((c) => c.cmd === "lm" && (c.args.argv as string[])[1] === "accept")?.args.argv).toEqual(["proposals", "accept", "0123456789ab", "--include-private"]);
  });

  it("a page that changed after the agent read it is refused by Living Memory: nothing is kept after, and the view reads it again", async () => {
    const { calls } = await folderInbox({ books: [wiki], page: { text: "one\n", sha256: "r1" }, accept: { exit_code: 6, error: { code: "stale", message: "Stale revision" } } });
    await until(() => !!button("Accept"));
    await act(async () => button("Accept")!.click());
    await until(() => toasts.some((t) => t.kind === "warn"));
    expect(order).toEqual(["snapshot:disk", "accept"]);   // no `agent` snapshot, no refresh, not settled
    expect(calls.filter((c) => c.cmd === "file_read").length).toBeGreaterThan(1);
  });

  it("merges against the page as the agent read it (the proposal's base), with the page as it is now as the other side", async () => {
    await folderInbox({ books: [wiki], page: { text: "now\n", sha256: "r9" } });
    await until(() => !!button("Merge…"));
    expect(button("Accept")).toBeUndefined();   // the page moved on: only a merge
    await act(async () => button("Merge…")!.click());
    await until(() => !!document.querySelector("[data-merge]"));
    const dialog = document.querySelector("[data-merge]")!;
    expect([dialog.getAttribute("data-base"), dialog.getAttribute("data-mine"), dialog.getAttribute("data-theirs")]).toEqual(["one\n", "now\n", "two\n"]);
    await act(async () => button("Use this merge")!.click());
    await until(() => order.includes("settled"));
    expect(order).toEqual(["snapshot:disk", "accept", "snapshot:agent", "refresh", "settled"]);
  });

  it("a merge refused because the page changed meanwhile keeps its dialog open, and is one proposals accept --edited", async () => {
    const { calls } = await folderInbox({ books: [wiki], page: { text: "now\n", sha256: "r9" }, accept: { exit_code: 6, error: { code: "stale", message: "Stale revision" } } });
    await until(() => !!button("Merge…"));
    await act(async () => button("Merge…")!.click());
    await until(() => !!document.querySelector("[data-merge]"));
    // The dialog is worded for an agent's proposal, not for a page that changed on disk.
    expect(document.querySelector("[data-merge]")?.getAttribute("data-noun")).toBe("proposal");
    await act(async () => button("Use this merge")!.click());
    await until(() => toasts.some((t) => t.kind === "warn"));
    expect(document.querySelector("[data-merge]")).not.toBeNull();
    const merges = calls.filter((c) => c.cmd === "lm_body");
    expect(merges.map((c) => [c.args.argv, c.args.body])).toEqual([[["proposals", "accept", "0123456789ab", "--edited", "--expected-revision", "r9", "--include-private"], "merged\n"]]);
    expect(order).toEqual(["snapshot:disk", "accept"]);
  });

  it("a merge that fails for another reason keeps its dialog open too", async () => {
    await folderInbox({ books: [wiki], page: { text: "now\n", sha256: "r9" }, accept: { exit_code: 1, error: { code: "internal", message: "The store is locked" } } });
    await until(() => !!button("Merge…"));
    await act(async () => button("Merge…")!.click());
    await until(() => !!document.querySelector("[data-merge]"));
    await act(async () => button("Use this merge")!.click());
    await until(() => toasts.some((t) => t.kind === "error"));
    expect(toasts.find((t) => t.kind === "error")?.text).toMatch(/locked/);
    expect(document.querySelector("[data-merge]")).not.toBeNull();
  });

  it("without a base the merge falls back to the page as it is now", async () => {
    await folderInbox({ books: [wiki], page: { text: "now\n", sha256: "r9" }, base: null });
    await until(() => !!button("Merge…"));
    await act(async () => button("Merge…")!.click());
    await until(() => !!document.querySelector("[data-merge]"));
    expect(document.querySelector("[data-merge]")?.getAttribute("data-base")).toBe("now\n");
  });

  it("a folder Hivemind has no notebook for is read through Living Memory, and its history is not touched", async () => {
    const { calls } = await folderInbox({ books: [], page: null });
    await until(() => !!button("Accept"));
    expect(calls.some((c) => c.cmd === "file_read")).toBe(false);
    expect(calls.find((c) => c.cmd === "lm" && (c.args.argv as string[])[1] === "read")?.args.argv)
      .toEqual(["doc", "read", "--file=C:/Users/me/Wiki/A.md", "--include-private", "--actor", "viewer"]);
    await act(async () => button("Accept")!.click());
    await until(() => order.includes("settled"));
    expect(order).toEqual(["accept", "settled"]);
  });

  it("an orphaned proposal (its folder is no longer registered) can only be rejected and never shows a gone-page banner", async () => {
    await folderInbox({ books: [wiki], page: { text: "one\n", sha256: "r1" }, orphaned: true });
    await until(() => !!button("Reject…"));
    expect(document.body.textContent).toMatch(/no longer has this folder registered/);
    expect(document.body.textContent).not.toMatch(/page the agent edited is gone/i);
    expect(button("Accept")).toBeUndefined();
    expect(button("Edit, then accept…")).toBeUndefined();
    expect(button("Merge…")).toBeUndefined();
  });

  it("keeps an empty string base for a 0-byte existing folder page", async () => {
    await folderInbox({ books: [wiki], page: { text: "now\n", sha256: "r9" }, base: "" });
    await until(() => !!button("Merge…"));
    await act(async () => button("Merge…")!.click());
    await until(() => !!document.querySelector("[data-merge]"));
    expect(document.querySelector("[data-merge]")?.getAttribute("data-base")).toBe("");
  });

  it("a page that is gone reads as no page: the proposal is stale and only a merge is offered", async () => {
    await folderInbox({ books: [wiki], page: null });
    await until(() => !!button("Merge…"));
    expect(document.body.textContent).toMatch(/gone/);
  });
});
