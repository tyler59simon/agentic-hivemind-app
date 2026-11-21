// NS-3C (Codex review of 9dda8ae, R1-2): a rich page is JSON, so a draft kept for it is never merged line by line into a
// file that changed on disk. It opens as the unsaved text, with the file as the version to keep or leave.
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
const sha = (text: string) => `sha-${text}`;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    const path = a?.path as string;
    switch (cmd) {
      case "file_read":
        if (!files.has(path)) throw new Error(`${path} not found`);
        return { text: files.get(path), sha256: sha(files.get(path)!), size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const docs = await import("./store");
const { draftKeyOf } = await import("./keys");
const { stringifyEnvelope } = await import("../features/hmdoc/envelope");
const { inspect } = await import("../features/hmdoc/validate");

const ref = (path: string) => ({ notebook: "nb-1", path });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const page = (...texts: string[]) => stringifyEnvelope({ schemaVersion: 1, format: "hivemind-rich", meta: {}, content: { type: "doc", content: texts.map(para) } } as never);

async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ok()).toBe(true);
}

/** A draft of `mine`, written against `base`, for `path`. */
async function keep(path: string, base: string, mine: string) {
  const key = await draftKeyOf(docs.keyOf(ref(path)));
  drafts.set(key, { key, kind: "file", target: ref(path), precondition: { sha256: sha(base), size: 1, mtimeMs: 1 }, format: { encoding: "UTF-8", bom: false, eol: "lf" }, base, mine, savedAt: "t" });
}

describe("a draft of a page that changed on disk", () => {
  beforeEach(() => { files.clear(); drafts.clear(); });

  // Each paragraph is a block of its own lines, so changes at the two ends do not touch and a line merge would be clean.
  const base = page("one", "two", "three");
  const mine = page("ONE", "two", "three");
  const theirs = page("one", "two", "THREE");

  it("R1-2: a rich page keeps its draft as the unsaved text and the file as theirs, never merged", async () => {
    files.set("Plan.hmdoc", theirs);
    await keep("Plan.hmdoc", base, mine);
    await docs.open(ref("Plan.hmdoc"));
    await until(() => !!docs.useDocuments.getState().docs[docs.keyOf(ref("Plan.hmdoc"))]?.theirs);
    const state = docs.useDocuments.getState().docs[docs.keyOf(ref("Plan.hmdoc"))];
    expect(state.text).toBe(mine);
    expect(state.theirs!.text).toBe(theirs);
    expect(state.status).toBe("stale");
    expect(inspect(state.text).ok).toBe(true);
  });

  it("a Markdown page still merges a draft into a changed file", async () => {
    const md = (a: string, c: string) => `${a}\n\nmiddle\n\n${c}\n`;
    files.set("Note.md", md("one", "THREE"));
    await keep("Note.md", md("one", "three"), md("ONE", "three"));
    await docs.open(ref("Note.md"));
    await until(() => docs.useDocuments.getState().docs[docs.keyOf(ref("Note.md"))]?.status === "dirty");
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("Note.md"))].text).toBe(md("ONE", "THREE"));
  });
});
