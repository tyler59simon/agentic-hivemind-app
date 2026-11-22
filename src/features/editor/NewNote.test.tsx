// @vitest-environment jsdom
// Codex review of 7320d7f, DATA-3: text typed while a new note's Save is still running is not lost. The request carries
// the text as it was when Save was pressed; the later text becomes an unsaved draft of the new note.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
const tabUpdates: Record<string, unknown>[] = [];
let release: (() => void) | null = null;
let sentPayload: { body: string; title: string } | null = null;
const made = { id: "1", domain: "d", title: "Plan", type: "knowledge", status: "active", tags: ["subject/project", "concern/knowledge"], revision: "rev-made", body: "A summary sentence.", truncated: false };

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => { invoked.push({ cmd, args }); return null; }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/lm", async (orig) => ({
  ...(await orig<typeof import("../../lib/lm")>()),
  domains: vi.fn(async () => ({ domains: [{ name: "d" }], aliases: {}, global_domains: [] })),
  taxonomy: vi.fn(async () => ({ tags: ["subject/project", "concern/knowledge"] })),
  capture: vi.fn((_domain: string, payload: { body: string; title: string }) => new Promise((resolve) => {
    sentPayload = payload;
    release = () => resolve({ ok: true, id: "1", status: "created", domain: "d", operation_id: "op" });
  })),
}));
vi.mock("../viewer/NoteView", () => ({ noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: async () => made }) }));
vi.mock("./useTitles", () => ({ useTitles: () => () => [] }));
vi.mock("./PropertiesForm", () => ({ TagPicker: () => null }));
vi.mock("../plans/DirectDialog", () => ({ DirectDialog: () => null }));
// Stable objects: the component has effects that depend on them.
const noteTypes = { def: () => undefined, active: [] };
vi.mock("../../lib/noteTypes", async (orig) => ({ ...(await orig<typeof import("../../lib/noteTypes")>()), useNoteTypes: () => noteTypes }));
vi.mock("../../store", () => ({ useApp: (sel: (s: { domain: string }) => unknown) => sel({ domain: "d" }) }));
const workspace = { updateTab: (_id: string, patch: Record<string, unknown>) => tabUpdates.push(patch), setDirty: () => {}, openNote: () => {} };
vi.mock("../../workspace/store", () => ({ useWorkspace: () => workspace }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: (p: { doc: string; onChange: (t: string) => void }) => <textarea aria-label="Body" value={p.doc} onChange={(e) => p.onChange(e.target.value)} />,
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NewNote } = await import("./NewNote");
const { setLmStore } = await import("../../documents/store");
const { noteDraftKey } = await import("./noteSessions");
const STORE = "C:/stores/a";

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  setLmStore(STORE);
  invoked.length = 0; tabUpdates.length = 0; release = null; sentPayload = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("a new note whose Save is still running", () => {
  it("keeps what was typed after Save as an unsaved draft of the new note", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tab = { id: "t9", kind: "new-note", title: "New note", init: { domain: "d" } } as never;
    await act(async () => root.render(<QueryClientProvider client={client}><NewNote tab={tab} /></QueryClientProvider>));
    await settle();
    await type(host.querySelector<HTMLInputElement>("input.title-input")!, "Plan");
    await type(host.querySelector("textarea")!, "A summary sentence.");
    await act(async () => { host.querySelector<HTMLButtonElement>("button.primary")!.click(); });
    await settle();
    expect(sentPayload?.body).toBe("A summary sentence.");
    // Typing while the request is still pending.
    await type(host.querySelector("textarea")!, "A summary sentence.\n\nTyped while saving.");
    await act(async () => { release!(); });
    await settle();

    expect(sentPayload?.body).toBe("A summary sentence.");
    const draft = invoked.filter((c) => c.cmd === "draft_put").map((c) => c.args.value as { key: string; ref: string; store: string; baseRevision: string; mine: { body: string }; base: { body: string } }).find((d) => d.key === noteDraftKey(STORE, "d:1"));
    expect(draft?.mine.body).toBe("A summary sentence.\n\nTyped while saving.");
    expect(draft?.base.body).toBe("A summary sentence.");
    expect(draft?.baseRevision).toBe("rev-made");
    expect(draft?.store).toBe(STORE);
    expect(tabUpdates[tabUpdates.length - 1]).toMatchObject({ kind: "note", ref: "d:1", mode: "live" });
  });

  it("writes no draft of the note when nothing was typed after Save", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tab = { id: "t9", kind: "new-note", title: "New note", init: { domain: "d" } } as never;
    await act(async () => root.render(<QueryClientProvider client={client}><NewNote tab={tab} /></QueryClientProvider>));
    await settle();
    await type(host.querySelector<HTMLInputElement>("input.title-input")!, "Plan");
    await type(host.querySelector("textarea")!, "A summary sentence.");
    await act(async () => { host.querySelector<HTMLButtonElement>("button.primary")!.click(); });
    await settle();
    await act(async () => { release!(); });
    await settle();
    expect(invoked.some((c) => c.cmd === "draft_put" && (c.args.value as { key: string }).key === noteDraftKey(STORE, "d:1"))).toBe(false);
    expect(tabUpdates[tabUpdates.length - 1]).toMatchObject({ kind: "note", ref: "d:1" });
  });
});
