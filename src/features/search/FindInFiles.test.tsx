// @vitest-environment jsdom
// NS-6B: find and replace in files, over a model of Rust's `replace_*` commands: results grouped by file, the preview with
// tick boxes, apply, the skipped list and Undo all.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: { cmd: string; args: Record<string, unknown> }[] = [];
const hunk = (index: number, line: number, before: string, after: string) => ({ index, line, before, after });
const preview = {
  files: [
    { path: "Projects/Plan.md", sha256: "sha-plan", matches: 2, hunks: [hunk(0, 3, "ship the cat", "ship the bird"), hunk(1, 9, "a cat sat", "a bird sat")] },
    { path: "Inbox.md", sha256: "sha-inbox", matches: 1, hunks: [hunk(0, 1, "cat food", "bird food")] },
  ],
  skipped: [{ path: "Old.txt", why: "This file mixes line-ending styles" }],
  matches: 3, capped: false, searched: 9, binary: 2, large: 1,
};
let applyAnswer: Record<string, unknown> = {};
let undoAnswer: Record<string, unknown> = {};
let failPreview = "";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }, { id: "nb-2", path: "C:\\other", title: "Other", added: "" }];
      case "get_settings": return { other_folders: ["C:\\code\\docs"] };
      case "replace_preview":
        if (failPreview) throw new Error(failPreview);
        return preview;
      case "replace_apply": return applyAnswer;
      case "replace_undo": return undoAnswer;
      case "file_read": return { text: "x", sha256: "s", size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
    }
    return null;
  }),
}));

const { FindInFilesTab, openFindInFiles } = await import("./FindInFiles");
const { useWorkspace } = await import("../../workspace/store");
const { useDocuments } = await import("../../documents/store");

let root: Root | null = null;
let el: HTMLElement;
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); });
async function mount() {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient()}><FindInFilesTab /></QueryClientProvider>); });
  await settle();
}
const type = (label: string, value: string) => act(async () => {
  const input = el.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const click = (label: string) => act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(); });
const button = (text: RegExp) => [...el.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const press = (text: RegExp) => act(async () => { button(text)!.click(); });
const submit = () => act(async () => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const select = (label: string, value: string) => act(async () => {
  const s = el.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  s.value = value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
});
const last = (cmd: string) => { const calls = sent.filter((s) => s.cmd === cmd); return calls[calls.length - 1]?.args as Record<string, any>; };

beforeEach(() => {
  sent.length = 0;
  failPreview = "";
  applyAnswer = {};
  undoAnswer = {};
  useWorkspace.setState({ panes: [{ id: "p", tabs: [], active: null }], focused: "p", dirty: {} });
  useDocuments.setState({ docs: {}, refs: {}, held: [] });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  el?.remove();
});

describe("find in files", () => {
  it("searches the chosen notebook with the options and groups the matches by file", async () => {
    await mount();
    expect([...el.querySelectorAll("select[aria-label='Where to search'] option")].map((o) => o.textContent)).toEqual(["Notebook", "Other", "C:\\code\\docs"]);
    await select("Where to search", "nb:nb-2");
    await type("Find", "cat");
    await click("Regular expression");
    await click("Whole word");
    await type("Files to include", "*.md, docs/**");
    await type("Files to exclude", "drafts/");
    await submit();
    expect(last("replace_preview")).toEqual({
      scope: { notebook: "nb-2" }, replacement: null,
      query: { pattern: "cat", regex: true, case: false, word: true, include: ["*.md", "docs/**"], exclude: ["drafts/"] },
    });
    expect(el.textContent).toContain("3 matches in 2 files");
    const files = [...el.querySelectorAll(".find-file")];
    expect(files.map((f) => f.querySelector(".find-path")!.textContent)).toEqual(["Projects/Plan.md", "Inbox.md"]);
    expect(files[0].querySelectorAll(".find-hunk")).toHaveLength(2);
    expect([...files[0].querySelectorAll(".find-line")].map((l) => l.textContent)).toEqual(["3", "9"]);
    expect(files[0].querySelector(".find-text mark")!.textContent).toBe("cat");
    // What was left out is said, and so is what cannot be changed.
    expect(el.textContent).toContain("Left out: 2 binary files, 1 file over 8 MB.");
    expect(el.textContent).toContain("Old.txt");
    expect(el.textContent).toContain("mixes line-ending styles");
    // No tick boxes or replace button for a plain search.
    expect(el.querySelector("input[type=checkbox]")).toBeNull();
    expect(button(/^Replace \d/)).toBeUndefined();
    // A group folds.
    await click("Hide matches in Projects/Plan.md");
    expect(files[0].querySelectorAll(".find-hunk")).toHaveLength(0);
  });

  it("can search a folder the user added, and a folder of a notebook from its menu", async () => {
    await mount();
    await select("Where to search", "folder:C:\\code\\docs");
    await type("Find", "x");
    await submit();
    expect(last("replace_preview").scope).toEqual({ folder: "C:\\code\\docs" });
    await act(async () => { openFindInFiles({ notebook: "nb-1", sub: "Projects" }); });
    await settle();
    expect((el.querySelector("select[aria-label='Where to search']") as HTMLSelectElement).value).toBe("nb:nb-1");
    expect(el.textContent).toContain("in Projects");
    await submit();
    expect(last("replace_preview").scope).toEqual({ notebook: "nb-1", sub: "Projects" });
    expect(useWorkspace.getState().panes[0].tabs.map((t) => t.kind)).toEqual(["find"]);
  });

  it("opens a match's page at its line", async () => {
    await mount();
    await select("Where to search", "nb:nb-1");
    await type("Find", "cat");
    await submit();
    await act(async () => { (el.querySelector(".find-file .find-hunk button.find-line") as HTMLElement).click(); });
    const tab = useWorkspace.getState().panes[0].tabs.find((t) => t.kind === "file");
    expect(tab?.file).toEqual({ notebook: "nb-1", path: "Projects/Plan.md" });
    expect(useWorkspace.getState().reveal).toMatchObject({ line: 3 });
  });

  it("says why a search failed", async () => {
    await mount();
    await select("Where to search", "nb:nb-1");
    await type("Find", "(");
    failPreview = "This is not a valid pattern: unclosed group";
    await submit();
    expect(el.querySelector("[role=alert]")!.textContent).toContain("not a valid pattern");
    expect(el.querySelector(".find-file")).toBeNull();
  });
});

describe("replace in files", () => {
  async function previewReplace() {
    await mount();
    await select("Where to search", "nb:nb-1");
    await type("Find", "cat");
    await press(/^Replace$/);
    await type("Replace with", "bird");
    await submit();
  }

  it("shows each change with a tick box and replaces only what stays ticked", async () => {
    await previewReplace();
    expect(last("replace_preview").replacement).toBe("bird");
    const hunks = [...el.querySelectorAll(".find-hunk")];
    expect(hunks).toHaveLength(3);
    expect(hunks[0].querySelector(".find-del")!.textContent).toBe("ship the cat");
    expect(hunks[0].querySelector(".find-add")!.textContent).toBe("ship the bird");
    expect(el.querySelectorAll("input[type=checkbox]")).toHaveLength(5);
    expect(button(/^Replace 3 matches in 2 files$/)).toBeDefined();
    // Untick one match of the first file, and the whole second file.
    await click("Replace line 9 of Projects/Plan.md");
    await click("Replace in Inbox.md");
    expect(button(/^Replace 1 match in 1 file$/)).toBeDefined();
    applyAnswer = { done: [{ path: "Projects/Plan.md", replaced: 1 }], skipped: [], undo: "undo-1" };
    await press(/^Replace 1 match in 1 file$/);
    expect(last("replace_apply")).toEqual({
      scope: { notebook: "nb-1" }, replacement: "bird", unsaved: [],
      query: { pattern: "cat", regex: false, case: false, word: false, include: [], exclude: [] },
      files: [{ path: "Projects/Plan.md", sha256: "sha-plan", hunks: [0] }],
    });
    expect(el.textContent).toContain("Replaced 1 match in 1 file.");
    // What was found is out of date once it is written.
    expect(el.querySelector(".find-file")).toBeNull();
  });

  it("changing the search takes the replace button away until it is previewed again", async () => {
    await previewReplace();
    expect(button(/^Replace 3 matches/)).toBeDefined();
    await type("Replace with", "fish");
    expect(button(/^Replace 3 matches/)).toBeUndefined();
    expect(el.textContent).toContain("the search changed");
    await submit();
    expect(button(/^Replace 3 matches/)).toBeDefined();
    // The ticked file is a tri-state box over its matches.
    await click("Replace line 9 of Projects/Plan.md");
    const box = el.querySelector<HTMLInputElement>("input[aria-label='Replace in Projects/Plan.md']")!;
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(true);
  });

  it("names files with unsaved edits in a tab, which are never written, and lists what was skipped", async () => {
    await previewReplace();
    useDocuments.setState({
      refs: { "file:nb-1:Inbox.md": { notebook: "nb-1", path: "Inbox.md" }, "file:nb-2:Plan.md": { notebook: "nb-2", path: "Plan.md" }, "file:nb-1:Clean.md": { notebook: "nb-1", path: "Clean.md" } },
      docs: { "file:nb-1:Inbox.md": { status: "dirty" }, "file:nb-2:Plan.md": { status: "dirty" }, "file:nb-1:Clean.md": { status: "clean" } } as never,
    });
    applyAnswer = {
      done: [{ path: "Projects/Plan.md", replaced: 2 }],
      skipped: [{ path: "Inbox.md", why: "it has unsaved edits in a tab; save or discard them first" }, { path: "Gone.md", why: "it changed after the preview" }],
      undo: "undo-2",
    };
    await press(/^Replace 3 matches/);
    expect(last("replace_apply").unsaved).toEqual(["Inbox.md"]);
    expect(el.textContent).toContain("Replaced 2 matches in 1 file.");
    const skipped = [...el.querySelectorAll(".find-skipped li")].map((li) => li.textContent);
    expect(skipped).toEqual(["Inbox.md: it has unsaved edits in a tab; save or discard them first", "Gone.md: it changed after the preview"]);
  });

  it("undoes all of a replace, and lists a file that changed since", async () => {
    await previewReplace();
    applyAnswer = { done: [{ path: "Projects/Plan.md", replaced: 2 }, { path: "Inbox.md", replaced: 1 }], skipped: [], undo: "undo-3" };
    await press(/^Replace 3 matches/);
    undoAnswer = { done: [{ path: "Projects/Plan.md", replaced: 0 }], skipped: [{ path: "Inbox.md", why: "it changed after the replace" }], undo: null };
    await press(/^Undo all$/);
    expect(last("replace_undo")).toEqual({ undo: "undo-3", unsaved: [] });
    expect(el.textContent).toContain("Put back 1 file.");
    expect(el.querySelector(".find-skipped")!.textContent).toBe("Inbox.md: it changed after the replace");
    // It cannot be undone twice.
    expect(button(/^Undo all$/)).toBeUndefined();
  });

  it("says when the search stopped at the limit", async () => {
    await mount();
    await select("Where to search", "nb:nb-1");
    await type("Find", "cat");
    preview.capped = true;
    try {
      await submit();
      expect(el.textContent).toContain("Stopped at 10,000 matches");
    } finally {
      preview.capped = false;
    }
  });
});
