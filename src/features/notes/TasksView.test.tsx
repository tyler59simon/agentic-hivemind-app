// @vitest-environment jsdom
// NS-7B: the Tasks view mounted for real: tasks of folder notebooks (from Hivemind's own index) and the open action items,
// the filters and grouping, and a tick that writes back with the hash the list was read at (or says why it did not).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const files = new Map<string, string>();
/** The revision `open` lists the action item's note at, and whether `check` answers that the note changed since. */
const lm = { revision: "rev1", stale: false };
const pad = (n: number) => String(n).padStart(2, "0");
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const sha = (raw: string) => `sha-${raw}`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "notebooks_list": return [{ id: "nb-1", path: "C:\\one", title: "Main", added: "" }];
      case "index_tasks": {
        const done = (args.filters as { done?: boolean }).done;
        const rows = [
          { notebook: "nb-1", path: "Plan.md", title: "Plan", line: 2, done: false, text: `pay the bill ⏫ 📅 ${day(-2)}`, due: day(-2), sha256: sha(files.get("Plan.md")!) },
          { notebook: "nb-1", path: "Plan.md", title: "Plan", line: 3, done: false, text: `call Ana 📅 ${day(0)}`, due: day(0), sha256: sha(files.get("Plan.md")!) },
          { notebook: "nb-1", path: "Plan.md", title: "Plan", line: 4, done: false, text: "no date at all", due: null, sha256: sha(files.get("Plan.md")!) },
          { notebook: "nb-1", path: "Plan.md", title: "Plan", line: 5, done: true, text: "already finished", due: null, sha256: sha(files.get("Plan.md")!) },
        ];
        return rows.filter((r) => done === undefined || r.done === done);
      }
      case "file_read": {
        const raw = files.get(args.path as string);
        if (raw === undefined) throw new Error("not found");
        return { text: raw, sha256: sha(raw), size: raw.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false };
      }
      case "file_save": {
        const raw = files.get(args.path as string)!;
        if (sha(raw) !== (args.pre as { sha256: string }).sha256) return { status: "stale", sha256: sha(raw) };
        files.set(args.path as string, args.text as string);
        return { status: "saved", sha256: sha(args.text as string), size: 1, mtimeMs: 2 };
      }
      case "lm": {
        const argv = args.argv as string[];
        if (argv[0] === "open") return { exit_code: 0, error: null, result: { ok: true, domain: null, notes: 1, count: 1, items: [{ ref: "demo:abc", short_ref: "abc", title: "Release work", type: "plan", updated: "", index: 1, item: "write the notes", revision: lm.revision }] } };
        if (argv[0] === "check" && lm.stale) return { exit_code: 6, result: null, error: { code: "stale", message: "stale_revision: demo:abc changed since revision rev1; read it again and redo the change" } };
        if (argv[0] === "check") return { exit_code: 0, error: null, result: { ok: true, item: "write the notes", index: 1, done: true, open: 0, revisions: { "demo:abc": "rev2" } } };
        return { exit_code: 0, error: null, result: {} };
      }
    }
    return null;
  }),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TasksView } = await import("./TasksView");
const { useConnection } = await import("../../lib/connection");
const { useToasts } = await import("../../ui/toast");
const { useWorkspace } = await import("../../workspace/store");
const { useApp } = await import("../../store");
const docs = await import("../../documents/store");

let root: Root | null = null;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const rows = () => [...document.querySelectorAll<HTMLElement>(".task-list li")];
const texts = () => rows().map((r) => r.querySelector(".task-text")?.textContent);
const select = async (label: string, value: string) => {
  const el = document.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
};
const tickBox = (text: string) => rows().find((r) => r.textContent?.includes(text))!.querySelector<HTMLInputElement>("input[type=checkbox]")!;

async function mount() {
  useConnection.setState({ commands: ["doc", "open"], api: 2, capabilities: { docs: { version: 1, max_page_bytes: 1 } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><TasksView /></QueryClientProvider>));
  await settle();
}

beforeEach(() => {
  calls.length = 0;
  files.clear();
  Object.assign(lm, { revision: "rev1", stale: false });
  files.set("Plan.md", "# Plan\n- [ ] pay the bill ⏫ 📅 " + day(-2) + "\n- [ ] call Ana 📅 " + day(0) + "\n- [ ] no date at all\n- [x] already finished\n");
  useToasts.setState({ items: [] });
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  useApp.setState({ route: { page: "notes", view: "tasks" }, back: [] });
  docs.useDocuments.setState({ docs: {}, refs: {} });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the Tasks view", () => {
  it("lists open tasks of every source, the ones with the earliest due date first, without the fields their columns show", async () => {
    await mount();
    // Due dates first (overdue, then today), then those with none, by notebook: the action items, a folder page.
    expect(texts()).toEqual(["pay the bill", "call Ana", "write the notes", "no date at all"]);
    const first = rows()[0];
    expect(first.querySelector(".chip.overdue")?.textContent).toBe(day(-2));
    expect(first.textContent).toContain("high");
    expect(first.textContent).toContain("Plan");
    expect(rows()[2].textContent).toContain("demo · action items");
    expect(rows()[3].textContent).toContain("Main");
  });

  it("reads page tasks from Hivemind's own index only: no doc command is sent", async () => {
    await mount();
    expect(calls.some((c) => c.cmd === "index_tasks")).toBe(true);
    expect(calls.some((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "doc")).toBe(false);
  });

  it("filters by due date, notebook, done and text, and groups", async () => {
    await mount();
    await select("Due", "overdue");
    expect(texts()).toEqual(["pay the bill"]);
    await select("Due", "today");
    expect(texts()).toEqual(["call Ana"]);
    await select("Due", "none");
    expect(texts()).toEqual(["write the notes", "no date at all"]);
    await select("Due", "any");
    await select("Notebook", "@actions");
    expect(texts()).toEqual(["write the notes"]);
    await select("Notebook", "");
    await select("Done", "done");
    expect(texts()).toEqual(["already finished"]);
    await select("Done", "all");
    expect(texts()).toHaveLength(5);
    const text = document.querySelector<HTMLInputElement>("input[aria-label='Text']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(text, "ANA"); text.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(texts()).toEqual(["call Ana"]);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(text, ""); text.dispatchEvent(new Event("input", { bubbles: true })); });
    await select("Group by", "due");
    expect([...document.querySelectorAll(".task-group h2")].map((h) => h.textContent?.replace(/\d+$/, "").trim())).toEqual(["Overdue", "Today", "No due date"]);
    await select("Group by", "page");
    expect([...document.querySelectorAll(".task-group h2")].map((h) => h.textContent?.replace(/\d+$/, "").trim())).toEqual(["Plan", "Release work"]);
  });

  it("ticking a task writes that one line against the hash the list was read at", async () => {
    await mount();
    const before = files.get("Plan.md")!;
    await act(async () => tickBox("call Ana").click());
    await settle();
    expect(files.get("Plan.md")).toBe(before.replace(`- [ ] call Ana 📅 ${day(0)}`, `- [x] call Ana 📅 ${day(0)}`));
    const save = calls.find((c) => c.cmd === "file_save")!;
    expect(save.args).toMatchObject({ notebook: "nb-1", path: "Plan.md", pre: { sha256: sha(before) } });
    expect(useToasts.getState().items).toEqual([]);
  });

  it("says so and writes nothing when the page changed since the list was read", async () => {
    await mount();
    // Someone adds a line above the tasks: the hash and the line numbers are no longer the list's.
    const changed = `# Plan\n\n${files.get("Plan.md")!.slice("# Plan\n".length)}`;
    files.set("Plan.md", changed);
    await act(async () => tickBox("call Ana").click());
    await settle();
    expect(files.get("Plan.md")).toBe(changed);
    expect(calls.some((c) => c.cmd === "file_save")).toBe(false);
    expect(useToasts.getState().items.map((t) => [t.kind, t.text])).toEqual([["error", expect.stringMatching(/changed since it was read, so nothing was written/)]]);
  });

  it("ticks an action item and opens both notes and pages from Tasks", async () => {
    await mount();
    await act(async () => tickBox("write the notes").click());
    await settle();
    expect(calls.find((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "check")!.args.argv)
      .toEqual(["check", "demo:abc", "--index", "1", "--domain", "demo", "--expected-revision", "rev1"]);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".task-page")].find((b) => b.textContent === "Release work")!.click());
    expect(useWorkspace.getState().panes[0].tabs).toEqual([expect.objectContaining({ kind: "note", ref: "demo:abc" })]);
    expect(useApp.getState().route).toEqual({ page: "notes" });
    useApp.getState().go({ page: "notes", view: "tasks" });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".task-page")].find((b) => b.textContent === "Plan")!.click());
    expect(useWorkspace.getState().panes[0].tabs[1]).toMatchObject({ kind: "file", file: { notebook: "nb-1", path: "Plan.md" } });
    expect(useApp.getState().route).toEqual({ page: "notes" });
  });

  it("reads the action items again when a tick finds the note changed, and the repeated tick sends the new revision", async () => {
    await mount();
    lm.stale = true;
    lm.revision = "rev2";
    const opens = () => calls.filter((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "open").length;
    const before = opens();
    await act(async () => tickBox("write the notes").click());
    await settle();
    const checks = () => calls.filter((c) => c.cmd === "lm" && (c.args.argv as string[])[0] === "check").map((c) => c.args.argv as string[]);
    expect(checks()).toHaveLength(1);   // never retried for the user
    expect(useToasts.getState().items.map((t) => [t.kind, t.text])).toEqual([["warn", "This note changed; reloaded."]]);
    expect(opens()).toBeGreaterThan(before);
    lm.stale = false;
    await act(async () => tickBox("write the notes").click());
    await settle();
    expect(checks()[1]).toEqual(["check", "demo:abc", "--index", "1", "--domain", "demo", "--expected-revision", "rev2"]);
  });
});
