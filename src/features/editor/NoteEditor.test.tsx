// @vitest-environment jsdom
// Codex review of 7320d7f, DATA-1: a note Living Memory returned cut off (truncated) is not editable in the body here,
// because a body sent back replaces the whole note and would delete the tail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stored: { id: string; domain: string; title: string; type: string; status: string; tags: string[]; revision: string; body: string; truncated: boolean };
const updates: { ref: string; payload: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/lm", async (orig) => ({
  ...(await orig<typeof import("../../lib/lm")>()),
  read: vi.fn(async () => stored),
  taxonomy: vi.fn(async () => ({ tags: ["subject/a", "concern/b", "subject/c"] })),
  update: vi.fn(async (ref: string, payload: Record<string, unknown>) => { updates.push({ ref, payload }); return { operation_id: "op" }; }),
}));
vi.mock("../viewer/NoteView", () => ({ noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: async () => stored }) }));
vi.mock("../links/useLinks", () => ({ useNoteLinks: () => ({ note: undefined }) }));
vi.mock("./useTitles", () => ({ useTitles: () => () => [] }));
vi.mock("./PropertiesForm", () => ({ PropertiesForm: () => null }));
vi.mock("../../lib/noteTypes", () => ({ useNoteTypes: () => ({ def: () => undefined, active: [] }) }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: (p: { doc: string; readOnly?: boolean; onChange: (t: string) => void }) =>
    <textarea aria-label="Body" value={p.doc} readOnly={!!p.readOnly} onChange={(e) => p.onChange(e.target.value)} />,
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NoteEditor } = await import("./NoteEditor");
const { setLmStore } = await import("../../documents/store");

let host: HTMLElement;
let head: HTMLElement;
let root: Root;
beforeEach(() => {
  setLmStore("C:/stores/a");
  updates.length = 0;
  host = document.createElement("div");
  head = document.createElement("div");
  document.body.append(host, head);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const mount = async (truncated: boolean) => {
  stored = { id: "1", domain: "d", title: "Long", type: "knowledge", status: "active", tags: ["subject/a", "concern/b"], revision: "r1", body: "A summary sentence.\n\nMore text.", truncated };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tab = { id: "t1", kind: "note", ref: "d:1", title: "Long" } as never;
  await act(async () => root.render(<QueryClientProvider client={client}><NoteEditor tab={tab} live head={head} /></QueryClientProvider>));
  await settle();
};
const body = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("the Memory note editor and a note that is too long", () => {
  it("edits the body of a note it read whole", async () => {
    await mount(false);
    expect(body().readOnly).toBe(false);
    expect(host.textContent).not.toContain("read-only here");
  });

  it("opens the body of a cut-off note read-only and says why", async () => {
    await mount(true);
    expect(body().readOnly).toBe(true);
    expect(host.textContent).toContain("read-only here");
  });

  it("still saves a title change of a cut-off note without sending the body", async () => {
    await mount(true);
    await type(head.querySelector("input")!, "Long, renamed");
    await act(async () => { head.querySelector<HTMLButtonElement>("button.primary")!.click(); });
    await settle();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ title: "Long, renamed", expected_revision: "r1" });
  });
});
