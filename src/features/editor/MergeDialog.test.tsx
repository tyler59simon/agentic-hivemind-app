// @vitest-environment jsdom
// NS-2C UI pass: "Edit, then accept" on an agent's proposal opened the dialog for a page that changed on disk, so the
// agent's text was labelled "Version on disk" and its button "Use version on disk". A proposal has its own wording.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageMergeDialog } from "./MergeDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// CodeMirror measures text through ranges, which jsdom does not lay out.
Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect = function () { return new DOMRect(); };

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function dialog(noun: "page" | "proposal", base: string, mine: string, theirs: string) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<PageMergeDialog noun={noun} base={base} mine={mine} theirs={theirs} onResolve={() => {}} onCancel={() => {}} />));
  const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());
  return { text: document.body.textContent ?? "", buttons };
}

describe("the merge dialog's wording", () => {
  it("an agent's proposal is named as the agent's, and accepting is what saving does", async () => {
    const { text, buttons } = await dialog("proposal", "a\n", "a\n", "b\n");
    expect(text).toContain("Merge the agent's edit");
    expect(text).toContain("Agent's version (read-only)");
    expect(text).not.toMatch(/on disk|Another program|after you started editing/);
    expect(buttons).toEqual(expect.arrayContaining(["Use the page as it is", "Use the agent's version", "Cancel", "Accept merged page"]));
    expect(buttons).not.toContain("Keep editing");
  });

  it("conflict markers in a proposal merge name the page and the agent", async () => {
    const { text } = await dialog("proposal", "a\n", "page\n", "agent\n");
    expect(text).toContain("<<<<<<< Page now");
    expect(text).toContain(">>>>>>> Agent's edit");
  });

  it("a page that changed on disk keeps its wording", async () => {
    const { text, buttons } = await dialog("page", "a\n", "mine\n", "theirs\n");
    expect(text).toContain("This page changed on disk");
    expect(text).toContain("<<<<<<< Your edit");
    expect(buttons).toEqual(expect.arrayContaining(["Use my version", "Use version on disk", "Keep editing", "Save merged page"]));
  });
});
