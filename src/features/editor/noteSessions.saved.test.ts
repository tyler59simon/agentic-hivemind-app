// Codex review of 9dfa56d, C3: a save that ends after the last editor of the note left (switched to Reading) clears the unsaved
// dot of its tabs when the save covers the draft, and leaves it when newer edits are in the draft.
import { beforeEach, describe, expect, it, vi } from "vitest";

const drafts = new Map<string, { mine: unknown }>();
vi.mock("../../lib/drafts", () => ({
  getDraft: vi.fn(async (k: string) => drafts.get(k) ?? null),
  deleteDraft: vi.fn(async (k: string) => { drafts.delete(k); }),
  putDraft: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { noteDraftKey, savedNote } = await import("./noteSessions");
const { useWorkspace } = await import("../../workspace/store");

const fields = (body: string) => ({ title: "T", body, type: "knowledge", tags: [], context: "", review_by: "", files: [] }) as never;
const sent = { base: fields("old"), mine: fields("new"), rev: "r1", version: 1 } as never;
const fresh = { title: "T", body: "new", type: "knowledge", tags: [], links: [], revision: "r2" } as never;

function noteTab() {
  useWorkspace.getState().openNote("demo:n1", { split: true });
  const tab = useWorkspace.getState().panes.flatMap((p) => p.tabs).find((t) => t.kind === "note" && t.ref === "demo:n1")!;
  useWorkspace.getState().setDirty(tab.id, true);
  return tab.id;
}

describe("a save that ends with no editor left", () => {
  beforeEach(() => { drafts.clear(); useWorkspace.setState({ dirty: {} }); });

  it("clears the dot when the save covers the draft", async () => {
    const id = noteTab();
    drafts.set(noteDraftKey("store", "demo:n1"), { mine: fields("new") });
    savedNote("store", "demo:n1", sent, fresh);
    await vi.waitFor(() => expect(useWorkspace.getState().dirty[id]).toBe(false));
    expect(drafts.size).toBe(0);
  });

  it("keeps the dot and the draft when the draft has newer edits", async () => {
    const id = noteTab();
    drafts.set(noteDraftKey("store", "demo:n1"), { mine: fields("newer") });
    savedNote("store", "demo:n1", sent, fresh);
    await new Promise((r) => setTimeout(r, 20));
    expect(useWorkspace.getState().dirty[id]).toBe(true);
    expect(drafts.size).toBe(1);
  });
});
