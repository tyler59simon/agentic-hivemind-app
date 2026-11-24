// @vitest-environment jsdom
// NS-5: the History mode of a page tab and the rail section beside it. Rust is replaced by a small model of its commands:
// a file on disk, the versions kept at each save, and the commits of a git repository.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

interface Kept { id: number; time: number; sha256: string; size: number; source: string; pinned: boolean; text: string }
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
const disk = { text: "", sha: 0 };
let kept: Kept[] = [];
let commits: { sha: string; author: string; date: string; subject: string; path: string; text: string }[] = [];
let git: { repo: string | null; changed: boolean } = { repo: null, changed: false };
let tooLarge = false;
let commitFails: string | null = null;
let saveFails: string | null = null;
const sha = (n: number) => `sha-${n}`;
const COMMIT = "c".repeat(40);

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../links/LinksPanel", () => ({ LinksPanel: () => null, LocalGraphPanel: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\nb", title: "Notebook", added: "" }];
      case "notebook_tree": return { entries: [], truncated: false };
      case "file_read": return { text: disk.text, sha256: sha(disk.sha), size: disk.text.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      case "file_save": {
        if (saveFails) throw new Error(saveFails);
        if ((a.pre as { sha256: string }).sha256 !== sha(disk.sha)) return { status: "stale", sha256: sha(disk.sha) };
        Object.assign(disk, { text: a.text as string, sha: disk.sha + 1 });
        kept.push({ id: kept.length + 1, time: Date.now(), sha256: sha(disk.sha), size: disk.text.length, source: (a.source as string) ?? "you", pinned: false, text: disk.text });
        return { status: "saved", sha256: sha(disk.sha), size: disk.text.length, mtimeMs: 2 };
      }
      case "history_list": return { entries: [...kept].reverse().map(({ text: _, ...entry }) => entry), tooLarge };
      case "history_read": {
        const id = a.id as string;
        if (id.startsWith("git:")) return { text: commits.find((c) => `git:${c.sha}` === id)!.text, binary: false, readOnly: null, size: 1 };
        return { text: kept.find((k) => String(k.id) === id)!.text, binary: false, readOnly: null, size: 1 };
      }
      case "history_pin": { const k = kept.find((x) => x.id === a.id)!; k.pinned = a.pinned as boolean; return null; }
      case "git_file_log": return { ...git, commits: git.repo ? commits.map(({ text: _, ...c }) => c) : [] };
      case "git_file_commit":
        if (commitFails) throw new Error(commitFails);
        git = { ...git, changed: false };
        return COMMIT;
      case "asset_base": return "http://hmfile.localhost/g/";
      case "draft_get": return null;
      case "draft_put": case "draft_delete": return null;
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { FileTab } = await import("../notes/FileTab");
const { PageRail } = await import("../../workspace/RightSidebar");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");
const { startDocumentSync } = await import("../../documents/sync");
const { timeline } = await import("./timeline");
const { usePick } = await import("./pick");
const { useToasts } = await import("../../ui/toast");
// jsdom lays nothing out, so the layout is checked in the stylesheet's text. Vitest hands `?raw` imports of CSS back empty,
// so the file is read from the project folder (tests run from it).
const nodeFs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync: (path: string, encoding: string) => string };
const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
const css = nodeFs.readFileSync(`${cwd}/src/App.css`, "utf8");

const ws = () => useWorkspace.getState();
const file = { notebook: "nb-1", path: "Plan.md" };
let root: Root | null = null;
let stop = () => {};

async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>); });
  return el;
}
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); });
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const byText = (selector: string, text: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((e) => (typeof text === "string" ? e.textContent === text : text.test(e.textContent ?? "")));
const rows = () => [...document.querySelectorAll(".history-list li")].map((li) => li.querySelector("strong")?.textContent);

/** A tab on `Plan.md` in History mode, open and loaded. */
async function historyTab(extra: Partial<{ path: string; notebook: string }> = {}) {
  const f = { ...file, ...extra };
  ws().openTab({ kind: "file", file: f, mode: "history" });
  const tab = ws().panes[0].tabs[0];
  const el = await mount(<FileTab tab={tab} />);
  await settle();
  return el;
}

beforeEach(() => {
  sent.length = 0;
  Object.assign(disk, { text: "now\n", sha: 3 });
  kept = [
    { id: 1, time: Date.parse("2026-11-19T09:00:00Z"), sha256: sha(1), size: 4, source: "disk", pinned: false, text: "first\n" },
    { id: 2, time: Date.parse("2026-11-20T09:00:00Z"), sha256: sha(2), size: 6, source: "you", pinned: false, text: "second\n" },
    { id: 3, time: Date.parse("2026-11-21T09:00:00Z"), sha256: sha(3), size: 4, source: "you", pinned: false, text: "now\n" },
  ];
  commits = [{ sha: "a".repeat(40), author: "Ada", date: "2026-11-20T12:00:00+00:00", subject: "Tidy the plan", path: "Plan.md", text: "tidy\n" }];
  git = { repo: null, changed: false };
  tooLarge = false; commitFails = null; saveFails = null;
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  useApp.setState({ route: { page: "notes" }, back: [] });
  docs.useDocuments.setState({ docs: {}, refs: {} });
  stop = startDocumentSync();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  stop();
});

describe("the timeline of a page", () => {
  it("merges the versions Hivemind kept with the commits, newest first", async () => {
    git = { repo: "C:/repo", changed: false };
    await historyTab();
    expect(rows()).toEqual(["Saved by you", "Tidy the plan", "Saved by you", "Found on disk"]);
    const commit = byText(".history-list button", /Tidy the plan/)!;
    expect(commit.textContent).toContain("Commit aaaaaaa by Ada");
  });

  it("is plain text files' History mode too, and names a file that is too large to keep", async () => {
    tooLarge = true;
    await historyTab({ path: "notes.txt" });
    expect(byText(".tabs button, [role=tab]", "History")).toBeTruthy();
    expect(document.body.textContent).toContain("over 16 MB, so its saves are not kept");
    expect(sent.some((c) => c.cmd === "history_list")).toBe(true);
  });

  it("says so when a file has no versions yet", async () => {
    kept = [];
    await historyTab();
    expect(document.body.textContent).toContain("No versions yet");
  });

  it("orders by time, puts a snapshot before a commit of the same moment, and sorts an unreadable date last", () => {
    const snap = (id: number, time: number) => ({ id, time, sha256: "x", size: 1, source: "you", pinned: false });
    const at = Date.parse("2026-01-01T00:00:00Z");
    const commit = (sha: string, date: string) => ({ sha, author: "A", date, subject: "s", path: "p" });
    const got = timeline([snap(1, at - 1000), snap(2, at)], [commit("c1", "2026-01-01T00:00:00Z"), commit("c2", "not a date"), commit("c3", "2025-12-31T00:00:00Z")]);
    expect(got.map((r) => r.id)).toEqual(["2", "git:c1", "1", "git:c3", "git:c2"]);
  });
});

describe("reading, comparing and restoring a version", () => {
  it("shows the chosen version's text, and Compare shows it beside the page as it is", async () => {
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    expect(document.querySelector(".history-text")?.textContent).toBe("first\n");
    expect(sent.find((c) => c.cmd === "history_read")?.args).toMatchObject({ notebook: "nb-1", path: "Plan.md", id: "1" });
    await click(byText(".history-pane button", "Compare with current"));
    const view = document.querySelector(".history-compare .cm-mergeView");
    expect(view).toBeTruthy();
    expect(view!.textContent).toContain("first");
    expect(view!.textContent).toContain("now");
  });

  it("reads a commit's version by its commit id", async () => {
    git = { repo: "C:/repo", changed: false };
    await historyTab();
    await click(byText(".history-list button", /Tidy the plan/));
    expect(sent.find((c) => c.cmd === "history_read")?.args.id).toBe(`git:${"a".repeat(40)}`);
    expect(document.querySelector(".history-text")?.textContent).toBe("tidy\n");
    expect(byText(".history-pane button", /Pin|Unpin/)).toBeUndefined();
  });

  it("Restore asks first, then saves the version as a new one from the page as it was", async () => {
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    await click(byText(".history-pane button", "Restore"));
    expect(sent.some((c) => c.cmd === "file_save")).toBe(false);
    expect(document.body.textContent).toContain("Replace the page with this version?");
    await click(byText(".history-pane button.primary", "Restore"));
    const save = sent.find((c) => c.cmd === "file_save")!;
    expect(save.args).toMatchObject({ notebook: "nb-1", path: "Plan.md", text: "first\n", source: "restore", pre: { sha256: sha(3) } });
    expect(disk.text).toBe("first\n");
    // The restore is a version of its own, and the list has the new one on top.
    expect(rows()[0]).toBe("Restored");
    expect(rows()).toHaveLength(4);
  });

  it("Restore is off for a page over 16 MB, whose current text the history could not keep (DATA-4)", async () => {
    tooLarge = true;
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    const restore = byText(".history-pane button", "Restore") as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect(restore.title).toMatch(/over 16 MB/);
  });

  it("a restore Rust refuses shows why and puts the page back as it is on disk (DATA-4)", async () => {
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    await click(byText(".history-pane button", "Restore"));
    saveFails = "This file is over 16 MB, so its current text cannot be kept in the history, and nothing was written";
    await click(byText(".history-pane button.primary", "Restore"));
    expect(useToasts.getState().items.map((t) => t.text).join(" ")).toContain("nothing was written");
    expect(disk.text).toBe("now\n");
    // The page is not left open with the old text as unsaved edits.
    expect(docs.useDocuments.getState().docs[docs.keyOf(file)]?.status).toBe("clean");
    expect(docs.useDocuments.getState().docs[docs.keyOf(file)]?.text).toBe("now\n");
  });

  it("Restore is off while the page has edits that are not saved, and for a page that is already this version", async () => {
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    const restore = () => byText(".history-pane button", "Restore") as HTMLButtonElement;
    expect(restore().disabled).toBe(false);
    await act(async () => { docs.edit(docs.keyOf(file), "typed\n"); });
    await settle();
    expect(restore().disabled).toBe(true);
    expect(restore().title).toMatch(/Save or discard/);
    await act(async () => { docs.edit(docs.keyOf(file), "now\n"); });
    await settle();
    // The newest version is the page itself.
    await click(document.querySelector(".history-list li:first-child button"));
    expect(restore().disabled).toBe(true);
    expect(document.body.textContent).toContain("same as the page now");
  });

  it("Pin keeps a version and Unpin lets it go", async () => {
    await historyTab();
    await click(byText(".history-list button", /Found on disk/));
    await click(byText(".history-pane button", "Pin"));
    expect(sent.find((c) => c.cmd === "history_pin")?.args).toEqual({ notebook: "nb-1", path: "Plan.md", id: 1, pinned: true });
    expect(kept[0].pinned).toBe(true);
    expect(byText(".history-list button", /Found on disk/)?.textContent).toContain("pinned");
    await click(byText(".history-pane button", "Unpin"));
    expect(kept[0].pinned).toBe(false);
  });
});

describe("Commit", () => {
  it("is offered for a file in a repository, only while it has changes, and commits it with the message", async () => {
    git = { repo: "C:/repo", changed: true };
    await historyTab();
    const open = byText(".history-commit button", /Commit/) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    await click(open);
    const dialog = document.querySelector("[role=dialog]")!;
    const ok = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Commit") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    const box = dialog.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Reword the plan");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(ok);
    expect(sent.find((c) => c.cmd === "git_file_commit")?.args).toEqual({ notebook: "nb-1", path: "Plan.md", message: "Reword the plan" });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect((byText(".history-commit button", /Commit/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows git's missing identity message in the dialog and keeps it open", async () => {
    git = { repo: "C:/repo", changed: true };
    commitFails = "Git has no author identity, so it cannot commit. Set one with: git config --global user.name";
    await historyTab();
    await click(byText(".history-commit button", /Commit/));
    const box = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "msg");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click([...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Commit"));
    expect(document.querySelector("[role=dialog] .error")?.textContent).toContain("Git has no author identity");
  });

  it("is not offered for a file outside a repository, or while the page has unsaved edits", async () => {
    await historyTab();
    expect(document.querySelector(".history-commit")).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    ws().closeTab("p0", ws().panes[0].tabs[0].id);
    git = { repo: "C:/repo", changed: true };
    await historyTab();
    await act(async () => { docs.edit(docs.keyOf(file), "typed\n"); });
    await settle();
    expect((byText(".history-commit button", /Commit/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the rail beside a page", () => {
  it("lists the five newest versions, and All opens the History mode", async () => {
    kept = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, time: Date.parse("2026-11-10T09:00:00Z") + i * 3_600_000, sha256: sha(i), size: 1, source: i === 0 ? "disk" : "you", pinned: false, text: `v${i}\n` }));
    ws().openTab({ kind: "file", file, mode: "source" });
    await mount(<PageRail />);
    await settle();
    const section = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "History")!;
    expect(section.querySelectorAll("ol.timeline li")).toHaveLength(5);
    await click(section.querySelector("header button, header a"));
    expect(ws().panes[0].tabs[0].mode).toBe("history");
  });

  it("UI-2: a row opens the History mode with that version selected and scrolled into view", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    ws().openTab({ kind: "file", file, mode: "source" });
    const tabId = ws().panes[0].tabs[0].id;
    await mount(<PageRail />);
    await settle();
    const rail = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "History")!;
    // Newest first: the second row is the version "second\n" (id 2).
    await click(rail.querySelectorAll("ol.timeline li button")[1]);
    expect(ws().panes[0].tabs[0].mode).toBe("history");
    expect(usePick.getState().picks[tabId]).toBe("2");
    // The History view takes the request once it has the timeline.
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await mount(<FileTab tab={ws().panes[0].tabs[0]} />);
    await settle();
    expect(document.querySelector(".history-list button[aria-pressed=true]")?.textContent).toContain("Saved by you");
    expect(document.querySelector(".history-text")?.textContent).toBe("second\n");
    expect(usePick.getState().picks[tabId]).toBeUndefined();
    expect(scrolled).toHaveBeenCalled();
  });

  it("UI-2: a row clicked while the History mode is already showing selects it there", async () => {
    ws().openTab({ kind: "file", file, mode: "history" });
    const tab = ws().panes[0].tabs[0];
    await mount(<FileTab tab={tab} />);
    await settle();
    expect(document.querySelector(".history-text")).toBeNull();
    await act(async () => { usePick.getState().pick(tab.id, "1"); });
    await settle();
    expect(document.querySelector(".history-text")?.textContent).toBe("first\n");
  });
});

describe("the History layout (UI-1)", () => {
  it("keeps the list and the version in one grid inside a container that follows the pane's width", async () => {
    await historyTab();
    const view = document.querySelector(".history-wrap > .history-view")!;
    expect(view).toBeTruthy();
    expect(view.querySelector(":scope > .history-side .history-list")).toBeTruthy();
  });

  it("gives the list a fixed narrow column and the version the rest, and stacks them in a narrow pane", () => {
    const rule = (selector: string) => new RegExp(`${selector.replace(/[.[\]()]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".history-view")).toMatch(/grid-template-columns:\s*15rem minmax\(0, 1fr\)/);
    expect(rule(".history-wrap")).toMatch(/container-type:\s*inline-size/);
    // The stacked layout answers to the pane (the container), not the window.
    expect(css).toMatch(/@container history \(max-width: 640px\) \{ \.history-view \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).not.toMatch(/@media[^{]*\{\s*\.history-view/);
  });
});
