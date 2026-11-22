// @vitest-environment jsdom
// Codex review of 7320d7f, DATA-2 and LM-2: two panes showing the same Memory note in Edit share one session and one
// draft, and a draft and a save belong to the store they were made in. The bridge is a fake with two stores that hold a
// copy of the same note; the editor is the real one.
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

interface FakeNote { id: string; domain: string; title: string; type: string; status: string; tags: string[]; revision: string; body: string; truncated: boolean }
const makeNote = (id: string, body: string, revision = "r1"): FakeNote => ({ id, domain: "d", title: "Plan", type: "knowledge", status: "active", tags: ["subject/a", "concern/b"], revision, body, truncated: false });

// The fake bridge serves one store at a time and, like Rust, refuses a request bound to an earlier generation.
const bridge = { store: "a", generation: 1 };
const notes: Record<string, Record<string, FakeNote>> = { a: {}, b: {} };
const disk = new Map<string, Record<string, unknown>>();
const calls: { cmd: string; key?: string; argv?: string[] }[] = [];
const writes: { store: string; ref: string; payload: Record<string, unknown>; generation?: number }[] = [];
let gate: Promise<void> | null = null;
const reply = (result: unknown) => ({ exit_code: 0, result, error: null });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { argv?: string[]; stdin?: string | null; generation?: number; key?: string; value?: Record<string, unknown> }) => {
    calls.push({ cmd, key: args.key, argv: args.argv });
    if (cmd === "draft_put") { disk.set(args.key!, args.value!); return null; }
    if (cmd === "draft_get") return disk.get(args.key!) ?? null;
    if (cmd === "draft_delete") { disk.delete(args.key!); return null; }
    if (cmd !== "lm") return null;
    if (args.generation !== undefined && args.generation !== bridge.generation) throw new Error("Living Memory switched to another store while this request waited, so Hivemind did not send it");
    const argv = args.argv!;
    if (argv[0] === "taxonomy") return reply({ tags: ["subject/a", "concern/b"] });
    const ref = argv[1];
    const note = notes[bridge.store][ref];
    if (argv[0] === "read") return reply({ ...note });
    if (argv[0] === "update") {
      const payload = JSON.parse(args.stdin!) as Record<string, unknown>;
      if (gate) await gate;
      if (payload.expected_revision !== note.revision) return { exit_code: 6, result: null, error: { code: "stale", message: "Stale revision" } };
      writes.push({ store: bridge.store, ref, payload, generation: args.generation });
      Object.assign(note, payload, { revision: `${note.revision}+` });
      return reply({ operation_id: "op" });
    }
    return reply({});
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg></svg>" })) } }));
vi.mock("../viewer/NoteView", async () => {
  const { read } = await import("../../lib/lm");
  return { noteQuery: (ref: string) => ({ queryKey: ["note", ref], queryFn: () => read(ref) }) };
});
vi.mock("../links/useLinks", () => ({ useNoteLinks: () => ({ note: undefined }) }));
vi.mock("./useTitles", () => ({ useTitles: () => () => [] }));
vi.mock("./PropertiesForm", () => ({ PropertiesForm: () => null }));
vi.mock("../../lib/noteTypes", () => ({ useNoteTypes: () => ({ def: () => undefined, active: [] }) }));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { NoteEditor } = await import("./NoteEditor");
const { setLmStore } = await import("../../documents/store");
const { setBridgeGeneration } = await import("../../lib/lm");
const { noteDraftKey } = await import("./noteSessions");

const ROOTS = { a: "C:/stores/a", b: "C:/stores/b" };
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

interface Pane { host: HTMLElement; head: HTMLElement; root: Root }
let panes: Pane[] = [];
let client: InstanceType<typeof QueryClient>;
beforeEach(() => {
  bridge.store = "a"; bridge.generation = 1;
  notes.a = {}; notes.b = {};
  disk.clear(); calls.length = 0; writes.length = 0; gate = null; panes = [];
  setBridgeGeneration(1);
  setLmStore(ROOTS.a);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  for (const p of panes) await act(async () => p.root.unmount());
  document.body.innerHTML = "";
  setBridgeGeneration(undefined);
});

/** A pane showing the note in Edit, as a split of the workspace does. */
const open = async (ref: string, id = `t${panes.length + 1}`): Promise<Pane> => {
  const host = document.createElement("div");
  const head = document.createElement("div");
  document.body.append(host, head);
  const pane = { host, head, root: createRoot(host) };
  panes.push(pane);
  const tab = { id, kind: "note", ref, title: "Plan" } as never;
  await act(async () => pane.root.render(<QueryClientProvider client={client}><NoteEditor tab={tab} live head={head} /></QueryClientProvider>));
  await settle();
  return pane;
};
const close = async (pane: Pane) => { await act(async () => pane.root.unmount()); panes = panes.filter((p) => p !== pane); await settle(); };
const view = (pane: Pane) => EditorView.findFromDOM(pane.host.querySelector<HTMLElement>(".cm-content")!)!;
const textOf = (pane: Pane) => view(pane).state.doc.toString();
const typeAtEnd = (pane: Pane, text: string) => act(async () => { const v = view(pane); v.dispatch({ changes: { from: v.state.doc.length, insert: text } }); });
// Pressing Save is a synchronous act, so a save held open by `gate` does not overlap the acts that follow.
const press = (pane: Pane) => act(() => { pane.head.querySelector<HTMLButtonElement>("button.primary")!.click(); });
const save = async (pane: Pane) => { press(pane); await settle(); };
const draftOf = (store: keyof typeof ROOTS, ref: string) => disk.get(noteDraftKey(ROOTS[store], ref)) as { mine: { body: string }; store: string; baseRevision: string } | undefined;

describe("two panes showing the same note in Edit (DATA-2)", () => {
  it("shows the text typed in one pane in the other", async () => {
    notes.a["d:1"] = makeNote("1", "A summary sentence.");
    const first = await open("d:1");
    const second = await open("d:1");
    expect(textOf(second)).toBe("A summary sentence.");
    await typeAtEnd(first, " Typed in the first pane.");
    await settle();
    expect(textOf(second)).toBe("A summary sentence. Typed in the first pane.");
    await typeAtEnd(second, " And in the second.");
    await settle();
    expect(textOf(first)).toBe("A summary sentence. Typed in the first pane. And in the second.");
  });

  it("keeps the draft when one pane closes while the other still shows the note", async () => {
    notes.a["d:2"] = makeNote("2", "A summary sentence.");
    const first = await open("d:2");
    const second = await open("d:2");
    await typeAtEnd(first, " Typed once.");
    await settle();
    await close(second);
    await wait(1100);
    expect(draftOf("a", "d:2")?.mine.body).toBe("A summary sentence. Typed once.");
    expect(calls.some((c) => c.cmd === "draft_delete")).toBe(false);
    // The pane that is left still holds the session: it goes on editing the same text.
    await typeAtEnd(first, " More.");
    await close(first);
    expect(draftOf("a", "d:2")?.mine.body).toBe("A summary sentence. Typed once. More.");
  });

  it("brings the text back from the one draft when the note is opened again", async () => {
    notes.a["d:3"] = makeNote("3", "A summary sentence.");
    const first = await open("d:3");
    const second = await open("d:3");
    await typeAtEnd(second, " Unsaved.");
    await close(first);
    await close(second);
    const again = await open("d:3");
    expect(textOf(again)).toBe("A summary sentence. Unsaved.");
    expect(again.host.textContent).toContain("Restored unsaved edits");
  });

  it("saves once for both panes, and Save in one pane clears Unsaved in the other", async () => {
    notes.a["d:4"] = makeNote("4", "A summary sentence.");
    const first = await open("d:4");
    const second = await open("d:4");
    await typeAtEnd(second, " Added.");
    await settle();
    expect(second.head.textContent).toContain("Unsaved");
    expect(first.head.textContent).toContain("Unsaved");
    await save(first);
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ body: "A summary sentence. Added.", expected_revision: "r1" });
    expect(first.head.textContent).toContain("Saved");
    expect(second.head.textContent).toContain("Saved");
    expect(draftOf("a", "d:4")).toBeUndefined();
  });

  it("keeps text typed while a save runs as the draft, not deleting it with the saved one", async () => {
    notes.a["d:5"] = makeNote("5", "A summary sentence.");
    const first = await open("d:5");
    const second = await open("d:5");
    await typeAtEnd(first, " Saved text.");
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    press(first);
    await settle();
    await typeAtEnd(second, " Typed during the save.");
    release();
    await settle();
    expect(writes[0].payload.body).toBe("A summary sentence. Saved text.");
    expect(textOf(first)).toBe("A summary sentence. Saved text. Typed during the save.");
    expect(draftOf("a", "d:5")?.mine.body).toBe("A summary sentence. Saved text. Typed during the save.");
    expect(draftOf("a", "d:5")?.baseRevision).toBe("r1+");
  });

  it("does not delete a draft that holds more than the save that finished after its panes closed", async () => {
    notes.a["d:6"] = makeNote("6", "A summary sentence.");
    const pane = await open("d:6");
    await typeAtEnd(pane, " Saved text.");
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    press(pane);
    await settle();
    await typeAtEnd(pane, " Typed after Save.");
    await close(pane);
    release();
    await settle();
    expect(draftOf("a", "d:6")?.mine.body).toBe("A summary sentence. Saved text. Typed after Save.");
  });
});

describe("drafts and saves belong to their store (LM-2)", () => {
  it("does not load a draft made in one store when the same note is opened in another", async () => {
    notes.a["d:7"] = makeNote("7", "A summary sentence.");
    notes.b["d:7"] = makeNote("7", "Store B has its own text.");
    const inA = await open("d:7");
    await typeAtEnd(inA, " Edited in store A.");
    await close(inA);
    expect(draftOf("a", "d:7")?.store).toBe(ROOTS.a);

    bridge.store = "b"; bridge.generation = 2;
    setBridgeGeneration(2);
    setLmStore(ROOTS.b);
    await client.resetQueries(); // what App's reconnect does: no store's cached note is shown in another
    const inB = await open("d:7");
    expect(textOf(inB)).toBe("Store B has its own text.");
    expect(inB.host.textContent).not.toContain("Restored");
    expect(inB.head.textContent).toContain("Saved");
    // Saving in B leaves A's draft where it was.
    await close(inB);
    expect(draftOf("a", "d:7")?.mine.body).toBe("A summary sentence. Edited in store A.");
    expect(draftOf("b", "d:7")).toBeUndefined();

    // Back in A the draft is still there.
    bridge.store = "a"; bridge.generation = 3;
    setBridgeGeneration(3);
    setLmStore(ROOTS.a);
    await client.resetQueries();
    const backInA = await open("d:7");
    expect(textOf(backInA)).toBe("A summary sentence. Edited in store A.");
  });

  it("does not write a save into the store Hivemind switched to", async () => {
    notes.a["d:8"] = makeNote("8", "A summary sentence.");
    notes.b["d:8"] = makeNote("8", "A summary sentence.");
    const pane = await open("d:8");
    await typeAtEnd(pane, " Edited in store A.");
    // The bridge moves to store B (the same revision) before the webview has heard of it.
    bridge.store = "b"; bridge.generation = 2;
    await save(pane);
    expect(writes).toHaveLength(0);
    expect(notes.b["d:8"].body).toBe("A summary sentence.");
    expect(pane.host.textContent).toContain("switched to another store");
    expect(textOf(pane)).toBe("A summary sentence. Edited in store A.");
    expect(pane.head.textContent).toContain("Unsaved");
  });

  it("sends the generation its base was read in with a save", async () => {
    notes.a["d:9"] = makeNote("9", "A summary sentence.");
    const pane = await open("d:9");
    await typeAtEnd(pane, " Edited.");
    await save(pane);
    expect(writes[0].generation).toBe(1);
  });
});

describe("a draft from before drafts named their store (LM-2)", () => {
  const legacy = (ref: string) => {
    const base = { title: "Plan", body: "A summary sentence.", type: "knowledge", tags: ["concern/b", "subject/a"], context: "", review_by: "", files: [] };
    disk.set(ref, { key: ref, ref, baseRevision: "r1", base, mine: { ...base, body: "A summary sentence. Old edits." }, savedAt: "2026-11-01T10:00:00.000Z" });
  };

  it("asks before using it, and uses it for this store when the user keeps it", async () => {
    notes.a["d:10"] = makeNote("10", "A summary sentence.");
    legacy("d:10");
    const pane = await open("d:10");
    expect(pane.host.textContent).toContain("This draft was made before Hivemind recorded which store it belongs to.");
    expect(pane.host.querySelector(".cm-content")).toBeNull();
    // Nothing is used or dropped until the user chooses.
    expect(disk.has("d:10")).toBe(true);
    const keep = [...pane.host.querySelectorAll("button")].find((b) => b.textContent === "Keep it here")!;
    await act(async () => keep.click());
    await settle();
    expect(textOf(pane)).toBe("A summary sentence. Old edits.");
    expect(pane.host.textContent).not.toContain("This draft was made before");
    expect(draftOf("a", "d:10")).toMatchObject({ store: ROOTS.a, mine: { body: "A summary sentence. Old edits." } });
    expect(disk.has("d:10")).toBe(false);
  });

  it("drops it when the user throws it away", async () => {
    notes.a["d:11"] = makeNote("11", "A summary sentence.");
    legacy("d:11");
    const pane = await open("d:11");
    const away = [...pane.host.querySelectorAll("button")].find((b) => b.textContent === "Throw it away")!;
    await act(async () => away.click());
    await settle();
    expect(textOf(pane)).toBe("A summary sentence.");
    expect(disk.has("d:11")).toBe(false);
    expect(draftOf("a", "d:11")).toBeUndefined();
    expect(pane.host.textContent).not.toContain("This draft was made before");
  });

  it("is asked once for both panes", async () => {
    notes.a["d:12"] = makeNote("12", "A summary sentence.");
    legacy("d:12");
    const first = await open("d:12");
    const second = await open("d:12");
    expect(second.host.textContent).toContain("This draft was made before");
    await act(async () => [...first.host.querySelectorAll("button")].find((b) => b.textContent === "Keep it here")!.click());
    await settle();
    expect(textOf(second)).toBe("A summary sentence. Old edits.");
    expect(second.host.textContent).not.toContain("This draft was made before");
  });
});
