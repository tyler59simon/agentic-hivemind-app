// @vitest-environment jsdom
// DESKA2-TAXO: the Note types section sits under the Tags page's h1, so its heading is an h2.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../../lib/noteTypes", async (orig) => ({
  ...(await orig<object>()),
  useNoteTypes: () => ({ all: [{ name: "plan", builtin: true, status: "active", description: "A plan" }] }),
}));

const { NoteTypesSection } = await import("./NoteTypesSection");

it("heads the section with an h2", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<NoteTypesSection tags={[]} />));
  expect([...el.querySelectorAll("h1, h2, h3, h4")].map((h) => [h.tagName, h.textContent])).toEqual([["H2", "Note types 1"]]);
  await act(async () => root.unmount());
  el.remove();
});
