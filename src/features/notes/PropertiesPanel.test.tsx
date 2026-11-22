// @vitest-environment jsdom
// NS-7B: the properties panel edits the page's frontmatter through its document session: typed fields, one key changes and
// every other byte of the page stays as it was, and a block that is not YAML is left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files = new Map<string, string>();
const drafts = new Map<string, unknown>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    switch (cmd) {
      case "file_read": {
        const raw = files.get(a.path as string)!;
        return { text: raw.replace(/\r\n/g, "\n"), sha256: `sha-${raw}`, size: raw.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: raw.includes("\r\n") ? "crlf" : "lf" }, readOnly: null, binary: false };
      }
      case "draft_put": drafts.set(a.key as string, a.value); return null;
      case "draft_get": return drafts.get(a.key as string) ?? null;
      case "draft_delete": drafts.delete(a.key as string); return null;
    }
    return null;
  }),
}));

const docs = await import("../../documents/store");
const { useWorkspace } = await import("../../workspace/store");
const { useToasts } = await import("../../ui/toast");
const { PropertiesPanel } = await import("./PropertiesPanel");

let root: Root | null = null;
const ref = (path: string) => ({ notebook: "nb-1", path });
const text = (path: string) => docs.useDocuments.getState().docs[docs.keyOf(ref(path))].text;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
const field = (name: string) => document.querySelector<HTMLInputElement>(`[aria-label='Property ${name}']`)!;
const typeInto = async (el: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); el.blur(); });
};

async function show(path: string, raw: string, readOnly = false) {
  files.set(path, raw);
  useWorkspace.getState().openTab({ kind: "file", file: ref(path) });
  await docs.open(ref(path));
  await settle();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<PropertiesPanel docKey={docs.keyOf(ref(path))} readOnly={readOnly} onOpenLink={(t) => linked.push(t)} />));
}
const linked: string[] = [];

const PAGE = "---\n# keep me\ntitle: \"Plan: Q4\"\nstatus:   active\ndone: false\ncount: 3\nwhen: 2026-12-01\ntags: [a, b]\nowner: \"[[Ana Diaz]]\"\nnested:\n  inner: x\n---\n# Body\n";

beforeEach(() => {
  files.clear(); drafts.clear(); linked.length = 0;
  useWorkspace.setState({ panes: [{ id: "p0", tabs: [], active: null }], focused: "p0", dirty: {}, reveal: null });
  docs.useDocuments.setState({ docs: {}, refs: {} });
  useToasts.setState({ items: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("the properties panel", () => {
  it("shows each key as a field of its kind, and a nested map as it is written", async () => {
    await show("P.md", PAGE);
    expect(document.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
    expect(field("title").value).toBe("Plan: Q4");
    expect(field("count").type).toBe("number");
    expect(field("when").type).toBe("date");
    expect(field("done").type).toBe("checkbox");
    expect(field("tags").value).toBe("a, b");
    expect(field("owner").className).toContain("props-link");
    expect(document.querySelector(".props-source")!.textContent).toBe("inner: x");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".props-row button.link")].find((b) => b.textContent === "Open")!.click());
    expect(linked).toEqual(["Ana Diaz"]);
  });

  it("changes only the edited key of the page, whatever kind the field is", async () => {
    await show("P.md", PAGE);
    await typeInto(field("status"), "done");
    expect(text("P.md")).toBe(PAGE.replace("status:   active", "status:   done"));
    await act(async () => field("done").click());
    expect(text("P.md")).toBe(PAGE.replace("status:   active", "status:   done").replace("done: false", "done: true"));
    await typeInto(field("tags"), "x, y z");
    await typeInto(field("count"), "4");
    expect(text("P.md")).toBe(PAGE.replace("status:   active", "status:   done").replace("done: false", "done: true").replace("[a, b]", "[x, y z]").replace("count: 3", "count: 4"));
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("P.md"))].status).toBe("dirty");
  });

  it("keeps Windows line endings: the editor's text is LF and the save writes the page's own", async () => {
    await show("W.md", PAGE.replace(/\n/g, "\r\n"));
    await typeInto(field("status"), "done");
    expect(text("W.md")).toBe(PAGE.replace("status:   active", "status:   done"));
    expect(docs.useDocuments.getState().docs[docs.keyOf(ref("W.md"))].base!.format.eol).toBe("crlf");
  });

  it("removes a property, and adds one of a chosen kind", async () => {
    await show("P.md", PAGE);
    await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='Remove property count']")!.click());
    expect(text("P.md")).toBe(PAGE.replace("count: 3\n", ""));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add property")!.click());
    const name = document.querySelector<HTMLInputElement>("[aria-label='Property name']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "reviewed"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    const kind = document.querySelector<HTMLSelectElement>("[aria-label='Property type']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(kind, "checkbox"); kind.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => document.querySelector<HTMLFormElement>(".props-add")!.requestSubmit());
    expect(text("P.md")).toBe(PAGE.replace("count: 3\n", "").replace("owner:", "reviewed: false\nowner:").replace("reviewed: false\nowner:", "owner:").replace("nested:\n  inner: x\n---", "nested:\n  inner: x\nreviewed: false\n---"));
  });

  it("makes a block for a page that has none", async () => {
    await show("N.md", "# Plain\n");
    expect(document.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => document.querySelector<HTMLButtonElement>("[aria-expanded]")!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add property")!.click());
    const name = document.querySelector<HTMLInputElement>("[aria-label='Property name']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "status"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => document.querySelector<HTMLFormElement>(".props-add")!.requestSubmit());
    expect(text("N.md")).toBe("---\nstatus: \"\"\n---\n# Plain\n");
  });

  it("leaves properties that are not YAML alone, and takes no edits on a page that cannot be changed", async () => {
    const bad = "---\nstatus: [1\n---\n# Body\n";
    await show("B.md", bad);
    await act(async () => document.querySelector<HTMLButtonElement>("[aria-expanded]")!.click());
    expect(document.querySelector(".props-body")!.textContent).toContain("not valid YAML");
    expect(document.querySelector("[aria-label='Property name']")).toBeNull();
    expect(text("B.md")).toBe(bad);
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await show("R.md", PAGE, true);
    expect(field("status").disabled).toBe(true);
    expect(document.querySelector("[aria-label='Remove property status']")).toBeNull();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Add property")).toBe(false);
  });
});
