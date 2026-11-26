// @vitest-environment jsdom
// Codex re-review, N03: a merge opened from the Inbox's selected memory card keeps its draft when a refresh removes that item
// or empties the Inbox. The Inbox owns the open dialog, not the card.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = { ref: "demo:abc", title: "Cache rule", type: "knowledge", updated: "2026-11-01", revision: "r1", action: "merge", pair: { ref: "demo:dup", title: "Cache rule (copy)", score: 0.9 } };
const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../preview/HoverPreview", () => ({ HoverPreview: ({ children }: { children: unknown }) => children }));
vi.mock("../../ui/Markdown", () => ({ Markdown: () => null }));
vi.mock("../../lib/connection", async (orig) => ({ ...(await orig<typeof import("../../lib/connection")>()), useProjectsEnabled: () => false }));
vi.mock("../../lib/agent", async (orig) => ({ ...(await orig<typeof import("../../lib/agent")>()), reviewFiles: vi.fn(async () => []), reviewRefresh: vi.fn(async () => undefined) }));
vi.mock("./useInboxItems", async () => {
  const { NO_COUNTS: none } = await import("./worklist");
  return {
    useInboxItems: () => ({
      counts: { ...none, memory: state.rows.length }, total: state.rows.length, loading: false, sessions: [], groups: [],
      due: { isLoading: false, error: null }, dueRows: state.rows, kindTotals: {}, deferred: undefined, covered: undefined, maintenanceLoading: false,
      unconfirmedNotes: [], drafts: [], pages: [], captures: [], applied: [], skills: [], syncs: [], registry: undefined, proposals: [], behind: [], dismiss: () => {},
    }),
  };
});

const lm = await import("../../lib/lm");
lm.setTransport(async (_cmd, args) => {
  const argv = (args as { argv: string[] }).argv;
  if (argv[0] === "read") {
    const title = argv[1] === "demo:abc" ? "Cache rule" : "Cache rule (copy)";
    return { exit_code: 0, error: null, result: { id: argv[1].split(":")[1], domain: "demo", title, type: "knowledge", status: "active", tags: [], revision: "r1", body: `${title} body.`, truncated: false } };
  }
  return { exit_code: 1, result: null, error: { code: "invalid", message: "not in this test" } };
});
const { InboxPage } = await import("./InboxPage");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("a merge opened from the Inbox", () => {
  it("stays open with its draft when the item leaves the Inbox", async () => {
    state.rows = [row];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = () => act(async () => root!.render(<QueryClientProvider client={client}><InboxPage /></QueryClientProvider>));
    await render();
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Merge…")!.click());
    await settle();
    const draft = document.querySelector<HTMLTextAreaElement>("textarea.merge-body")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "My draft.");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });

    state.rows = [];
    await render();
    await settle();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Merge…")).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>("textarea.merge-body")?.value).toBe("My draft.");
  });
});
