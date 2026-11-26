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

const state = { revision: "rev1", stale: false, reviews: 0 };
const confirms: string[][] = [];
lm.setTransport(async (_cmd, args) => {
  const argv = (args as { argv: string[] }).argv;
  if (argv[0] === "review") {
    state.reviews += 1;
    return { exit_code: 0, error: null, result: { ok: true, domain: null, due: 1, notes: [{ ref: "demo:abc", title: "Cache rule", type: "knowledge", updated: "2026-11-01", revision: state.revision }] } };
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

afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; useToasts.setState({ items: [] }); });

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
});
