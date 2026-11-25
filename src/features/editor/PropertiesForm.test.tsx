// @vitest-environment jsdom
// Every field of the properties form has a name that is visible text (DESK-A11Y A2): axe accepts a placeholder as a name, so this
// checks the labels directly. The row headings name the fields they sit beside.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { PropertiesForm, TagPicker } = await import("./PropertiesForm");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

/** The name of a field: the text of the element `aria-labelledby` points at, or its `aria-label`. */
function nameOf(field: Element): string {
  const by = field.getAttribute("aria-labelledby");
  return by ? document.getElementById(by)?.textContent ?? "" : field.getAttribute("aria-label") ?? "";
}

describe("PropertiesForm", () => {
  it("names the type, tags, context, review by and files fields by their row headings", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    const fields = { title: "T", body: "", type: "knowledge" as const, tags: ["a/b"], context: "", review_by: "", files: [] };
    await act(async () => root!.render(<QueryClientProvider client={new QueryClient()}><PropertiesForm fields={fields} taxonomy={[]} onChange={() => {}} /></QueryClientProvider>));
    const controls = [...el.querySelectorAll<HTMLElement>("select, input, textarea")];
    expect(controls.map(nameOf)).toEqual(["Type", "Tags", "Context", "Review by", "Files"]);
    // A heading's text is visible, so the name is too; each id is used once.
    expect(new Set(controls.map((c) => c.getAttribute("aria-labelledby"))).size).toBe(5);
    await expectNoNewAxeViolations(el, []);
  });

  it("names a tag field that has no heading", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<TagPicker tags={[]} taxonomy={[]} onChange={() => {}} />));
    expect(nameOf(el.querySelector("input")!)).toBe("Add tag");
  });
});
