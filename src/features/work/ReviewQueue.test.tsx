// @vitest-environment jsdom
// The review queue's writes carry the revision the row was listed at. A note changed since is refused as stale: the queue is
// read again, the user is told, and the next click sends the new revision. Nothing is retried for the user.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../preview/HoverPreview", () => ({ HoverPreview: ({ children }: { children: unknown }) => children }));

const { QueryClient, QueryClientProvider, useQuery } = await import("@tanstack/react-query");
const lm = await import("../../lib/lm");
const { ReviewQueue } = await import("./ReviewQueue");
const { useToasts } = await import("../../ui/toast");

const state: { revision: string; stale: boolean; reviews: number; pair?: { ref: string; title: string; score: number } } = { revision: "rev1", stale: false, reviews: 0 };
const confirms: string[][] = [];
const archives: string[][] = [];
lm.setTransport(async (_cmd, args) => {
  const argv = (args as { argv: string[] }).argv;
  if (argv[0] === "review") {
    state.reviews += 1;
    return { exit_code: 0, error: null, result: { ok: true, domain: null, due: 1, notes: [{ ref: "demo:abc", title: "Cache rule", type: "knowledge", updated: "2026-11-01", revision: state.revision,
      ...(state.pair ? { action: "merge", pair: state.pair } : {}) }] } };
  }
  if (argv[0] === "read") {
    const pair = argv[1] === "demo:abc" ? { title: "Cache rule", body: "Cache body." } : { title: "Cache rule (copy)", body: "Copy body." };
    return { exit_code: 0, error: null, result: { id: argv[1].split(":")[1], domain: "demo", type: "knowledge", status: "active", tags: [], revision: state.revision, truncated: false, ...pair } };
  }
  if (argv[0] === "archive") {
    archives.push(argv);
    if (state.stale) return { exit_code: 6, result: null, error: { code: "stale", message: "stale_revision: demo:abc changed since revision rev1; read it again and redo the change" } };
    return { exit_code: 0, error: null, result: { ok: true, operation_id: "a-1", state: "committed", undo: "undo a-1" } };
  }
  if (argv[0] === "confirm") {
    confirms.push(argv);
    if (state.stale) return { exit_code: 6, result: null, error: { code: "stale", message: "stale_revision: demo:abc changed since revision rev1; read it again and redo the change" } };
    return { exit_code: 0, error: null, result: { ok: true, id: "abc", status: "confirmed", operation_id: "d-1" } };
  }
  return { exit_code: 0, error: null, result: {} };
});

function Queue() {
  const review = useQuery({ queryKey: ["review"], queryFn: () => lm.review({ allDomains: true }) });
  return review.data ? <ReviewQueue rows={review.data.notes} snooze={false} /> : null;
}

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const stillTrue = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Still true")!;

afterEach(async () => {
  await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; useToasts.setState({ items: [] });
  Object.assign(state, { revision: "rev1", stale: false, pair: undefined });
});
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><Queue /></QueryClientProvider>));
  await settle();
  return client;
}

describe("the review queue", () => {
  it("confirms with the listed revision, and after a stale refusal reads the queue again and sends the new one", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Queue /></QueryClientProvider>));
    await settle();

    Object.assign(state, { stale: true, revision: "rev2" });
    const reviewsBefore = state.reviews;
    await act(async () => stillTrue().click());
    await settle();
    expect(confirms).toEqual([["confirm", "demo:abc", "--domain", "demo", "--expected-revision", "rev1"]]);
    expect(useToasts.getState().items.map((t) => [t.kind, t.text])).toEqual([["warn", "This note changed; reloaded."]]);
    expect(state.reviews).toBeGreaterThan(reviewsBefore);

    state.stale = false;
    await act(async () => stillTrue().click());
    await settle();
    expect(confirms[1]).toEqual(["confirm", "demo:abc", "--domain", "demo", "--expected-revision", "rev2"]);
  });

  // Codex review of e30902f, R1: the dialog keeps the revision the row showed when it opened, whatever the queue reads since.
  it("archives with the revision shown when the dialog opened, not the one a refresh brought", async () => {
    const client = await mount();
    await act(async () => button("Archive…").click());
    state.revision = "rev2";
    await act(async () => { await client.refetchQueries({ queryKey: ["review"] }); });
    await settle();
    expect(client.getQueryData<{ notes: { revision: string }[] }>(["review"])?.notes[0].revision).toBe("rev2");
    state.stale = true;
    await act(async () => button("Archive").click());
    await settle();
    expect(archives).toEqual([["archive", "demo:abc", "--domain", "demo", "--expected-revision", "rev1"]]);
    expect(document.querySelector("[role=dialog] .error")?.textContent).toBe("This note changed; reloaded.");
    state.stale = false;
    await act(async () => button("Archive").click());
    await settle();
    expect(archives[1]).toEqual(["archive", "demo:abc", "--domain", "demo", "--expected-revision", "rev2"]);
  });

  // Codex review of e30902f, S1: the merge composer stays open with its draft when the refreshed row has no pair any more.
  it("keeps the open merge composer when the row loses its pair", async () => {
    state.pair = { ref: "demo:dup", title: "Cache rule (copy)", score: 0.9 };
    const client = await mount();
    await act(async () => button("Merge…").click());
    await settle();
    const draft = document.querySelector<HTMLTextAreaElement>("textarea.merge-body")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "My draft.");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.pair = undefined;
    await act(async () => { await client.refetchQueries({ queryKey: ["review"] }); });
    await settle();
    expect(button("Merge…")).toBeUndefined();
    expect(document.querySelector<HTMLTextAreaElement>("textarea.merge-body")?.value).toBe("My draft.");
  });
});
