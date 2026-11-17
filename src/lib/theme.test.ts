// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { prefs } from "./prefs";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8");

/** The selectors and body of every top-level rule (App.css has no nested rules). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim()),
  body: m[2],
}));
/** The body of the token block whose selector list includes `selector`. */
const block = (selector: string) => {
  const rule = rules.find((r) => r.selectors.includes(selector) && /^\s*--/m.test(r.body));
  if (!rule) throw new Error("no block " + selector);
  return rule.body;
};
const values = (selector: string) =>
  new Map([...block(selector).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()] as [string, string]));
const colours = (selector: string) => [...values(selector).keys()].filter((t) => !t.startsWith("--font-"));

const purple = colours(":root");
const emerald = values(':root[data-theme="emerald"]');
const light = values(':root[data-theme="emerald-light"]');

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("themes", () => {
  it("gives every colour token a value in each theme", () => {
    for (const theme of [emerald, light]) {
      expect(purple.filter((t) => !theme.has(t))).toEqual([]);
      expect([...theme.keys()].filter((t) => !purple.includes(t))).toEqual([]);
    }
  });

  it("keeps the Emerald dark colours in the light theme's sidebar and terminal", () => {
    // Both share the whole Emerald dark block, so nothing inside them mixes dark and light tokens.
    for (const scope of [':root[data-theme="emerald-light"] .sidebar', ':root[data-theme="emerald-light"] .term-box'])
      expect(values(scope)).toEqual(emerald);
    // A dialog opened from the sidebar (Modal has no portal) gets the whole light block back.
    expect(values(':root[data-theme="emerald-light"] .sidebar .overlay')).toEqual(light);
    expect(css).toContain(':root[data-theme="emerald-light"] .sidebar { --bg-sidebar: ' + emerald.get("--bg") + "; }"); // the requested #002d2a
    // Purple defines each --term-* token as var(--x); the light theme gives it Emerald dark's --x.
    const source = values(":root");
    for (const [token, value] of light) {
      if (!token.startsWith("--term-")) continue;
      const from = source.get(token)!.match(/^var\((--[a-z0-9-]+)\)$/)?.[1];
      expect([token, value]).toEqual([token, from ? emerald.get(from) : emerald.get(token)]);
    }
  });

  it("meets WCAG AA in Emerald Enterprise Light", () => {
    const c = (token: string) => light.get(token)!;
    const surfaces = ["--bg", "--bg-alt", "--bg-hover"];
    for (const text of ["--fg", "--fg-soft", "--fg-meta", "--muted", "--accent", "--teal", "--running", "--error", "--success", "--done", "--warn", "--border-lilac", "--syntax-string", "--syntax-type", "--syntax-fn"])
      for (const surface of surfaces) expect([text, surface, contrast(c(text), c(surface)) >= 4.5]).toEqual([text, surface, true]);
    const pairs: [string, string][] = [["--on-primary", "--primary"], ["--on-primary", "--primary-hover"], ["--on-danger", "--error"],
      ["--warn-fg", "--warn-bg"], ["--warn-fg", "--banner-warn-bg"], ["--chip-ok-fg", "--chip-ok-bg"], ["--chip-run-fg", "--chip-run-bg"],
      ["--chip-next-fg", "--chip-next-bg"], ["--fg", "--chip-bg"], ["--fg", "--badge-bg"], ["--fg", "--accent-soft"], ["--fg", "--diff-add"],
      ["--fg", "--diff-del"], ["--fg", "--bg-code"], ["--accent", "--accent-soft"], ["--fg", "--tab-on"], ["--fg", "--row-on"], ["--outline-fg", "--bg-alt"],
      ["--fg", "--accent-strong"]]; // .segmented .on and .folder-pick.on fill with --accent-strong under page text
    for (const [fg, bg] of pairs) expect([fg, bg, contrast(c(fg), c(bg)) >= 4.5]).toEqual([fg, bg, true]);
    // Borders of controls and the selection markers need 3:1 against the page.
    for (const ui of ["--border-strong", "--outline-border", "--selected", "--selected-node", "--progress"])
      expect([ui, contrast(c(ui), c("--bg-alt")) >= 3 && contrast(c(ui), c("--bg")) >= 3]).toEqual([ui, true]);
  });

  it("darkens the note-type colours for the light theme", () => {
    const shades = [...css.matchAll(/:root\[data-theme="emerald-light"\] \.type-[a-z, :\[\]="-.]*\{ color: (#[0-9a-f]{6}); \}/g)].map((m) => m[1]);
    expect(shades.length).toBe(11);
    for (const shade of shades) for (const surface of ["--bg", "--bg-alt", "--bg-hover"]) expect([shade, contrast(shade, light.get(surface)!) >= 4.5]).toEqual([shade, true]);
  });
});

describe("saved theme", () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  afterEach(() => { store.clear(); delete g.localStorage; });
  const fake = () => { g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } }; };

  it("falls back to Purple when nothing is saved", () => {
    expect(prefs.theme()).toBe("purple");
  });

  it("keeps each theme and treats an unknown id as Purple", () => {
    fake();
    for (const theme of ["emerald", "emerald-light", "purple"] as const) { prefs.setTheme(theme); expect(prefs.theme()).toBe(theme); }
    store.set("hivemind.theme", "sepia");
    expect(prefs.theme()).toBe("purple");
  });
});
