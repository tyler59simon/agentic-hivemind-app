// @vitest-environment jsdom
// Accessibility of the quick capture window (DESK-A11Y A1), in its Memory note form and its page form, checked with axe. The
// baseline lists what axe reports today; a later stage removes an entry when it fixes the cause.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoNewAxeViolations } from "../../test/axe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: async () => {}, onFocusChanged: async () => () => {} }) }));

const { QuickCapture } = await import("./QuickCapture");

let root: Root | null = null;
const click = (label: string) => act(async () => { [...document.querySelectorAll<HTMLElement>("button, [role=tab]")].find((b) => b.textContent === label)!.click(); });

beforeEach(async () => {
  localStorage.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["domains"], { domains: [{ name: "work", bound: true, active: 3 }], aliases: {}, global_domains: [], foreign_domains: [] });
  client.setQueryData(["taxonomy"], { tags: ["area/work", "kind/idea"] });
  client.setQueryData(["projects"], { projects: [{ slug: "alpha", name: "Alpha", status: "active", tag: "project/alpha" }] });
  client.setQueryData(["notebooks"], [{ id: "nb-1", path: "C:\notes", title: "Notes", added: "" }]);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<QueryClientProvider client={client}><QuickCapture /></QueryClientProvider>));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** What axe reports on both forms today: nothing. */
const BASELINE: string[] = [];

/** Axe accepts a placeholder as a name, so the labels are checked here: every field has a label element, and the label's text is
 *  part of the placeholder (or the placeholder is part of it) so the visible text is in the name. */
function expectLabelled() {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=hidden]), textarea")];
  expect(fields.length).toBeGreaterThanOrEqual(3);
  for (const f of fields) {
    const name = [...(f.labels ?? [])].map((l) => l.textContent).join(" ") || f.getAttribute("aria-label") || "";
    expect(name, `a name for the ${f.placeholder} field`).not.toBe("");
    if (f.placeholder && f.labels?.length) expect(f.placeholder.toLowerCase()).toContain(name.toLowerCase());
  }
}

describe("the quick capture window", () => {
  it("draws the Memory note form, and has only the violations recorded in the baseline", async () => {
    expect(document.querySelector("select[aria-label=Domain]")).not.toBeNull();
    expect(document.querySelectorAll("textarea").length).toBe(2);
    expectLabelled();
    await expectNoNewAxeViolations(document.body, BASELINE);
  });

  it("names the window Quick capture - Hivemind, as capture.rs does at its start", () => {
    expect(document.title).toBe("Quick capture - Hivemind");
  });

  it("has only the violations recorded in the baseline in the page form", async () => {
    await click("Today's page");
    expect(document.querySelector("select[aria-label=Notebook]")).not.toBeNull();
    expectLabelled();
    await expectNoNewAxeViolations(document.body, BASELINE);
  });
});
