// UI-1 and UI-2 of NS-4A: a match stays visible on the selected row in every theme, and Living Memory's unmarked snippets
// get their matches marked on the client.
// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DocSearchHit } from "../../lib/lm";
import { MARK_CLOSE, MARK_OPEN, markWords, marked, queryTerms } from "../../lib/noteindex";
import { buildGroups } from "./groups";

const css: string = readFileSync(new URL("../../App.css", import.meta.url), "utf8");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim()), body: m[2] }));
const tokens = (selector: string) => {
  const rule = rules.find((r) => r.selectors.includes(selector) && /^\s*--/m.test(r.body))!;
  return new Map([...rule.body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]));
};
const themes = [":root", ':root[data-theme="emerald"]', ':root[data-theme="emerald-light"]'];
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe("UI-1: the match on the selected row", () => {
  const row = rules.find((r) => r.selectors.includes(".search-group li button.on"))!;
  const mark = rules.find((r) => r.selectors.includes(".search-group li button.on mark"))!;

  it("its matches are drawn in the accent colour, which stands out from the row's background in every theme", () => {
    expect(row.body).toContain("background: var(--accent-soft)");
    expect(mark.body).toContain("background: none");
    expect(mark.body).toContain("color: var(--accent)");
    for (const theme of themes) {
      const t = tokens(theme);
      // The selected row's own colour is --accent-soft: its matches are drawn in --accent on it, and read clearly.
      expect(t.get("--accent")).not.toBe(t.get("--accent-soft"));
      expect(contrast(t.get("--accent")!, t.get("--accent-soft")!)).toBeGreaterThan(3);
      expect(contrast(t.get("--fg")!, t.get("--accent-soft")!)).toBeGreaterThan(4.5);
    }
  });

  it("the panel is not inside a white document pane, whose tokens would change it: data-paper is set on a pane body only", () => {
    const workspace: string = readFileSync(new URL("../../workspace/Workspace.tsx", import.meta.url), "utf8");
    expect(workspace).toMatch(/className="pane-body" data-paper=/);
    const topbar: string = readFileSync(new URL("../../shell/Topbar.tsx", import.meta.url), "utf8");
    expect(topbar).not.toContain("data-paper");
  });
});

describe("queryTerms", () => {
  it("reads words as the index does: the last bare word, or one ending in a star, is a prefix; a phrase is not", () => {
    expect(queryTerms('"exact phrase" rel* more')).toEqual([
      { text: "exact phrase", phrase: true, prefix: false }, { text: "rel", phrase: false, prefix: true }, { text: "more", phrase: false, prefix: true },
    ]);
    expect(queryTerms("first second")).toEqual([{ text: "first", phrase: false, prefix: false }, { text: "second", phrase: false, prefix: true }]);
    expect(queryTerms("- ( ) *")).toEqual([]);
  });
});

describe("UI-2: marking a query's words in a snippet", () => {
  const on = (text: string) => marked(text).filter((p) => p.on).map((p) => p.text);

  it("marks a word whatever its case, the last word also as a prefix", () => {
    expect(on(markWords("Release 2.0 of the releases and a Releaser", "release"))).toEqual(["Release", "release", "Release"]);
    expect(markWords("Release 2.0", "release")).toBe(`${MARK_OPEN}Release${MARK_CLOSE} 2.0`);
  });

  it("an earlier word matches whole only, a phrase with any spacing, and overlaps are merged", () => {
    expect(on(markWords("plans and planning", "plan plan"))).toEqual(["plan", "plan"]);
    expect(on(markWords("plans plan planning", "plan x"))).toEqual(["plan"]);
    expect(on(markWords("the quarterly   goals, quarterly numbers", '"quarterly goals"'))).toEqual(["quarterly   goals"]);
    expect(markWords("abcabc", "abc abc")).toBe(`${MARK_OPEN}abc${MARK_CLOSE}abc`);
    expect(markWords("releases", "release* releas*")).toBe(`${MARK_OPEN}release${MARK_CLOSE}s`);
  });

  it("is safe with text that looks like a pattern or like a mark", () => {
    expect(on(markWords("a.b (x) [y] c++ and a*b", "a.b"))).toEqual(["a.b"]);
    expect(on(markWords("cost is (x) now", "(x)"))).toEqual(["x"]);
    expect(markWords("plain \u0001already\u0002 marked", "zzz")).toBe("plain already marked");
    expect(markWords("<b>release</b>", "release")).toBe(`<b>${MARK_OPEN}release${MARK_CLOSE}</b>`);
    expect(markWords("nothing here", "")).toBe("nothing here");
    expect(on(markWords("Über Straße naïve", "uber über"))).toEqual(["Über"]);
  });

  it("marks Living Memory page and memory note snippets in the grouped results, while keeping folder page marks intact", () => {
    const lm = { domain: "demo", notebook: "plans", notebook_title: "Plans", title: "Roadmap.md", path: "Roadmap.md", heading: null, snippet: "Release 2.0 is out", line_start: 1, line_end: 1, revision: "r", score: 1, relevance: 1 } as DocSearchHit;
    const groups = buildGroups({
      titles: new Map(), query: "release", lmSearch: true, lm: [lm], lmNotebooks: [{ domain: "demo", notebook: "plans" }],
      here: [{ notebook: "nb-1", path: "A.md", kind: "md", title: "A", titleMarked: "A", mtimeMs: 1, snippet: `the ${MARK_OPEN}release${MARK_CLOSE} plan` }], other: [],
      memory: [{ id: "demo:1", domain: "demo", title: "N", type: "decision", snippet: "Release notes" } as never], current: "nb-1",
    });
    const snippet = (id: string) => groups.find((g) => g.id === id)!.rows[0].snippet;
    expect(snippet("lm")).toBe(`${MARK_OPEN}Release${MARK_CLOSE} 2.0 is out`);
    expect(snippet("here")).toBe(`the ${MARK_OPEN}release${MARK_CLOSE} plan`);
    expect(snippet("memory")).toBe(`${MARK_OPEN}Release${MARK_CLOSE} notes`);
  });
});
