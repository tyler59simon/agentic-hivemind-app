// @vitest-environment jsdom
// Codex review of e30902f, S3: saving a new note as the replacement of a similar one sends that note's revision. When it changed
// after the user chose it, the draft stays, the note is read again and shown as it is now, and the user chooses again; nothing
// is saved as a separate note without that choice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const old = vi.hoisted(() => ({ title: "Old rule", revision: "r1" }));
const sent: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/lm", async (orig) => {
  const real = await orig<typeof import("../../lib/lm")>();
  return {
    ...real,
    domains: vi.fn(async () => ({ domains: [{ name: "d" }], aliases: {}, global_domains: [] })),
    taxonomy: vi.fn(async () => ({ tags: ["subject/project", "concern/knowledge"] })),
    meta: vi.fn(async () => ({ id: "old", domain: "d", type: "knowledge", status: "active", tags: [], ...old })),
    capture: vi.fn(async (_domain: string, payload: Record<string, unknown>) => {
      sent.push(payload);
      const replaces = (payload.supersedes as string[] | undefined)?.[0];
      if (!replaces && !payload.allow_similar) throw new real.LmError("possible_duplicate", `possible_duplicate: similar to d:old "${old.title}"`, 2);
      if (replaces && replaces !== `d:old@${old.revision}`) throw new real.LmError("stale", "stale_revision: d:old changed since revision r1; read it again and redo the change", 6);
      return { ok: true, id: "new", status: "created", domain: "d", operation_id: "op" };
    }),
  };
});
vi.mock("../viewer/NoteView", () => ({ noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: async () => ({ id: "new", domain: "d", title: "Plan", type: "knowledge", status: "active", tags: [], revision: "x", body: "", truncated: false }) }) }));
vi.mock("./useTitles", () => ({ useTitles: () => () => [] }));
vi.mock("./PropertiesForm", () => ({ TagPicker: () => null }));
vi.mock("../plans/DirectDialog", () => ({ DirectDialog: () => null }));
const noteTypes = { def: () => undefined, active: [] };
vi.mock("../../lib/noteTypes", async (orig) => ({ ...(await orig<typeof import("../../lib/noteTypes")>()), useNoteTypes: () => noteTypes }));
vi.mock("../../store", () => ({ useApp: (sel: (s: { domain: string }) => unknown) => sel({ domain: "d" }) }));
const workspace = { updateTab: () => {}, setDirty: () => {}, openNote: () => {} };
vi.mock("../../workspace/store", () => ({ useWorkspace: () => workspace }));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: (p: { doc: string; onChange: (t: string) => void }) => <textarea aria-label="Body" value={p.doc} onChange={(e) => p.onChange(e.target.value)} />,
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NewNote } = await import("./NewNote");

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  sent.length = 0;
  Object.assign(old, { title: "Old rule", revision: "r1" });
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
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

describe("saving a new note as the replacement of a note that changed", () => {
  it("reads the note again and asks once more, with its new revision", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tab = { id: "t1", kind: "new-note", title: "New note", init: { domain: "d" } } as never;
    await act(async () => root.render(<QueryClientProvider client={client}><NewNote tab={tab} /></QueryClientProvider>));
    await settle();
    await type(host.querySelector<HTMLInputElement>("input.title-input")!, "Plan");
    await type(host.querySelector("textarea")!, "A summary sentence.");
    await act(async () => { host.querySelector<HTMLButtonElement>("button.primary")!.click(); });
    await settle();
    expect(document.body.textContent).toContain("Living Memory found “Old rule”");

    // The old note is renamed and edited after the dialog read it.
    Object.assign(old, { title: "Old rule, renamed", revision: "r2" });
    await act(async () => button("Save as its replacement")!.click());
    await settle();
    expect(sent.map((p) => p.supersedes)).toEqual([undefined, ["d:old@r1"]]);
    expect(document.body.textContent).toContain("The note this one replaces changed after you chose it.");
    expect(document.body.textContent).toContain("Living Memory found “Old rule, renamed”");
    expect(host.querySelector("textarea")!.value).toBe("A summary sentence.");

    await act(async () => button("Save as its replacement")!.click());
    await settle();
    expect(sent.map((p) => p.supersedes)).toEqual([undefined, ["d:old@r1"], ["d:old@r2"]]);
    expect(sent.some((p) => p.allow_similar)).toBe(false);
  });
});
