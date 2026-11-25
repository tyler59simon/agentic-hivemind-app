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
// Fonts, document layout and spacing are not colours (DESK-TYPE).
const colours = (selector: string) => [...values(selector).keys()].filter((t) => !/^--(font|doc|sp)-|^--(row-h|control-h)$/.test(t));

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

  it("gives buttons, controls and switches enough contrast in every theme (DESK-3)", () => {
    for (const [name, theme] of [["purple", values(":root")], ["emerald", emerald], ["light", light]] as const) {
      const c = (token: string) => theme.get(token)!.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3");
      const at = (fg: string, bg: string, min: number) => expect([name, fg, bg, contrast(c(fg), c(bg)) >= min]).toEqual([name, fg, bg, true]);
      at("--on-primary", "--primary", 4.5);
      at("--on-primary", "--primary-hover", 4.5);
      for (const surface of ["--bg", "--bg-alt", "--bg-input"]) at("--control-border", surface, 3);
      // A switch: the knob against its track in both states.
      at("--switch-knob", "--switch-track", 3);
      at("--switch-knob-on", "--primary", 3);
    }
    // The track's own edge is --control-border (an inset line), so it shows on the page in both states.
    expect(css).toMatch(/\.switch span \{[^}]*box-shadow: inset 0 0 0 1px var\(--control-border\)/);
  });

  it("has no text under .8rem, except the tab dot glyph and the compact sidebar count", () => {
    const small = css.split("\n").filter((l) => /font-size: ?\.[0-7]\d*rem/.test(l));
    expect(small.map((l) => l.trim().split(" {")[0].trim())).toEqual([".note-tab-pill .dot", ".nav-item .nav-count"]);
  });

  it("darkens the note-type colours for the light theme", () => {
    const shades = [...css.matchAll(/:root\[data-theme="emerald-light"\] \.type-[a-z, :\[\]="-.]*\{ color: (#[0-9a-f]{6}); \}/g)].map((m) => m[1]);
    expect(shades.length).toBe(13);
    for (const shade of shades) for (const surface of ["--bg", "--bg-alt", "--bg-hover"]) expect([shade, contrast(shade, light.get(surface)!) >= 4.5]).toEqual([shade, true]);
  });
});

describe("white document paper", () => {
  /** Every token a rule sets, over all rules that list `selector` (the palette has its own block). */
  const tokens = (selector: string) => {
    const found = rules.filter((r) => r.selectors.includes(selector) && /^\s*--/m.test(r.body));
    return new Map(found.flatMap((r) => [...r.body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string])));
  };
  const paper = tokens("[data-paper]");
  const light_ = tokens(':root[data-theme="emerald-light"]');

  it("sets the same tokens, with the same values, as Emerald Light, including the rich page palette", () => {
    expect(paper.size).toBeGreaterThan(100);
    expect([...paper.keys()].sort()).toEqual([...light_.keys()].sort());
    expect(paper).toEqual(light_);
    expect([...paper.keys()].filter((t) => t.startsWith("--pal-")).length).toBe(16);
    // Every colour token of the app theme is covered, so nothing inside the pane keeps a dark value.
    expect(purple.filter((t) => !paper.has(t))).toEqual([]);
  });

  it("puts light text on the pane and a white page behind it", () => {
    const rule = rules.find((r) => r.selectors.includes("[data-paper]") && /color:\s*var\(--fg\)/.test(r.body));
    expect(rule?.body).toMatch(/background:\s*var\(--bg-alt\)/);
    expect(light.get("--bg-alt")).toBe("#ffffff");
  });

  it("is the only place besides the sidebar and terminal that sets tokens on something other than the root", () => {
    const setters = rules.filter((r) => /^\s*--(bg|fg):/m.test(r.body)).flatMap((r) => r.selectors).sort();
    expect(setters).toEqual([
      ":root", ":root[data-theme=\"emerald\"]", ":root[data-theme=\"emerald-light\"]", ":root[data-theme=\"emerald-light\"] .sidebar",
      ":root[data-theme=\"emerald-light\"] .sidebar .overlay", ":root[data-theme=\"emerald-light\"] .term-box", "[data-paper]",
    ].sort());
  });

  it("darkens the note-type colours on the pane as the light theme does", () => {
    const shadesOf = (scope: string) => new Map(rules.flatMap((r) => {
      const shade = r.body.match(/color:\s*(#[0-9a-f]{6});/)?.[1];
      return shade ? r.selectors.filter((sel) => sel.startsWith(scope + " .type-")).map((sel) => [sel.slice(scope.length + 1), shade] as [string, string]) : [];
    }));
    const light = shadesOf(':root[data-theme="emerald-light"]');
    expect(light.size).toBe(14); // the 13 rules of the test above, one of them for two types
    expect(shadesOf("[data-paper]")).toEqual(light);
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
