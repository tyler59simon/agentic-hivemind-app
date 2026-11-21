// @vitest-environment jsdom
// NS-3A: Reading mode renders what Live renders: callouts, highlights, comments hidden, math, picture widths and
// `![[embeds]]`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../ui/Math", () => ({
  MathView: ({ tex, display }: { tex: string; display: boolean }) => <span data-math={display ? "display" : "inline"}>{tex}</span>,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { prepare, prepareForReading, MATH_MARK } from "../editor/rich/reading";
import { PageView } from "./PageView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function render(text: string, extra: Partial<Parameters<typeof PageView>[0]> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<PageView text={text} tabId="t" onLink={() => {}}
    pictures={{ base: "http://hmfile.localhost/g/", folder: "Plans", files: ["Plans/Q1.md", "img/cat.png", "Other/cat.png"] }} {...extra} />));
  return el;
}

describe("reading a page", () => {
  it("prepares math as code and drops comments, leaving code and prices alone", () => {
    const text = "Area $\\pi r^2$ costs $5 and $6. %% hidden %%\n\n$$\n\\frac{a}{b}\n$$\n\n`$x$` stays";
    const out = prepareForReading(text);
    expect(out).toContain(`\`${MATH_MARK}\\pi r^2\``);
    expect(out).toContain("costs $5 and $6. ");
    expect(out).not.toContain("hidden");
    expect(out).toContain("```math\n\\frac{a}{b}\n```");
    expect(out).toContain("`$x$` stays");
    expect(prepareForReading("no math here")).toBe("no math here");
  });

  it("renders math, highlights and callouts, a folded callout as details", async () => {
    const el = await render("Here $x^2$ and ==marked== text.\n\n$$\ny\n$$\n\n> [!warning]- Careful\n> Body text\n\n> [!tip] Hint\n> More");
    expect(el.querySelector('[data-math="inline"]')?.textContent).toBe("x^2");
    expect(el.querySelector('[data-math="display"]')?.textContent).toBe("y");
    expect(el.querySelector("mark")?.textContent).toBe("marked");
    const folded = el.querySelector("details.callout.callout-warning");
    expect(folded?.querySelector("summary")?.textContent).toBe("Careful");
    expect(folded?.hasAttribute("open")).toBe(false);
    expect(folded?.textContent).toContain("Body text");
    const tip = el.querySelector("div.callout.callout-tip");
    expect(tip?.querySelector(".callout-title")?.textContent).toBe("Hint");
    expect(tip?.textContent).not.toContain("[!tip]");
  });

  it("sizes pictures from their alt text and finds ![[name.png]] in the notebook", async () => {
    const el = await render("![A cat|120](../img/cat.png)\n\n![[cat.png|80]]");
    const [first, second] = [...el.querySelectorAll("img")];
    expect(first.getAttribute("src")).toBe("http://hmfile.localhost/g/img/cat.png");
    expect(first.getAttribute("alt")).toBe("A cat");
    expect(first.getAttribute("width")).toBe("120");
    expect(second.getAttribute("src")).toBe("http://hmfile.localhost/g/img/cat.png");
    expect(second.getAttribute("width")).toBe("80");
  });

  it("draws an embedded page's section, and shows embeds inside it as links", async () => {
    const read = vi.fn(async () => ({ title: "Q1", path: "Plans/Q1.md", text: "# Q1\n\n## Goals\nShip it. ![[Q1]]\n\n![[Q1]]\n\n## Later\nNo" }));
    const el = await render("Before\n\n![[Q1#Goals]]", { embed: read });
    await act(async () => {});
    expect(read).toHaveBeenCalledWith("Q1");
    const embed = el.querySelector(".page-embed")!;
    expect(embed.textContent).toContain("Q1 › Goals");
    expect(embed.textContent).toContain("Ship it.");
    expect(embed.textContent).not.toContain("No");
    // The embedded page's own `![[Q1]]` paragraph is a link, not another embed.
    expect(embed.querySelectorAll(".page-embed").length).toBe(0);
    expect([...embed.querySelectorAll("a.wikilink")].some((a) => a.textContent === "Q1")).toBe(true);
  });

  it("keeps quotes, lists, block boundaries and heading lines around math and comments (Codex review of 398b956 and re-review)", async () => {
    const text = "> $$\n> x^2\n> $$\n\n# After\n\n$$y$$\n---\n\n- a %%one\n  two%%# not a heading\n\n- $$z$$\n\n## End";
    const out = prepareForReading(text);
    expect(out).toContain("> ```math\n> x^2\n> ```");
    expect(out).toContain("```math\ny\n```\n---");
    expect(out).toContain("- a \n  \\# not a heading");
    expect(out).toContain("- ```math\n  z\n  ```");
    const el = await render(text);
    expect(el.querySelector("blockquote [data-math=\"display\"]")?.textContent).toBe("x^2");
    expect(el.querySelectorAll('[data-math="display"]').length).toBe(3);
    expect(el.querySelector("hr")).not.toBeNull();
    expect([...el.querySelectorAll("h1")].map((h) => [h.textContent, h.id])).toEqual([["After", "t-l4"]]);
    expect(el.querySelector("h2")?.id).toBe("t-l14");
    expect(el.querySelector("li [data-math=\"display\"]")?.textContent).toBe("z");
    // Lines a fence adds map back to the line it came from.
    const { sourceLine } = prepare("$$a$$\n# H");
    expect([0, 1, 2, 3].map(sourceLine)).toEqual([0, 0, 0, 1]);
  });

  it("keeps every math line inside its list, and a comment from joining a callout's title to its body (Codex re-review of fd7109e)", async () => {
    const el = await render("- $$x\n y$$\n- next\n\n> [!note]- Title %% hidden\n> more %% Body\n\nA %%c\nd%%# not a heading");
    const items = [...el.querySelectorAll("li")];
    expect(items.length).toBe(2);
    expect(items[0].querySelector('[data-math="display"]')?.textContent).toBe("x\ny");
    expect(items[1].textContent).toBe("next");
    expect(el.querySelector("details.callout summary")?.textContent).toBe("Title");
    expect(el.querySelector("details.callout")?.textContent).toContain("Body");
    expect(el.querySelector("h1")).toBeNull();
    expect(el.textContent).toContain("# not a heading");
  });

  it("keeps embeds mounted when other text of the page changes", async () => {
    const read = vi.fn(async () => ({ title: "Q1", path: "Plans/Q1.md", text: "Inside" }));
    // The page passes the same handlers and file list while only its text changes.
    const onLink = () => {};
    const pictures = { base: "http://hmfile.localhost/g/", folder: "Plans", files: ["Plans/Q1.md"] };
    const el = await render("One\n\n![[Q1]]", { embed: read, onLink, pictures });
    await act(async () => root!.render(<PageView text={"Two\n\n![[Q1]]"} tabId="t" onLink={onLink} embed={read} pictures={pictures} />));
    expect(el.textContent).toContain("Two");
    expect(el.textContent).toContain("Inside");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves bold that runs past a callout's title line in its body", async () => {
    const el = await render("> [!note]- Fix **this\n> one** now\n> Body");
    expect(el.querySelector("details.callout summary")?.textContent).toBe("Fix");
    expect(el.querySelector("details.callout strong")?.textContent).toBe("this\none");
  });

  it("keeps a callout's formatted title in its summary", async () => {
    const el = await render("> [!note]- Fix **this** now\n> Body");
    const summary = el.querySelector("details.callout summary");
    expect(summary?.textContent).toBe("Fix this now");
    expect(summary?.querySelector("strong")?.textContent).toBe("this");
    expect(el.querySelector("details.callout")?.textContent).toContain("Body");
  });

  it("follows a link inside an embed from the embedded page's folder", async () => {
    const onLink = vi.fn();
    const read = vi.fn(async () => ({ title: "Plan", path: "Projects/Plan.md", text: "See [[Todo]]" }));
    const el = await render("![[Plan]]", { embed: read, onLink });
    await act(async () => {});
    (el.querySelector(".page-embed a.wikilink") as HTMLElement).click();
    expect(onLink).toHaveBeenCalledWith("Todo", false, "Projects/Plan.md");
  });

  it("shows an embed as a link when the page cannot read other pages", async () => {
    const el = await render("![[Q1]]");
    expect(el.querySelector(".page-embed")).toBeNull();
    expect(el.querySelector("a.wikilink")?.textContent).toBe("Q1");
  });
});
