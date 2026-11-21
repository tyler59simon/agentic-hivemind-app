// NS-3D: no embed is ever an iframe. Nothing in the app's source builds one, so a page can never load another page into
// the window (NS-3D, the phase doc's section 5).
import { describe, expect, it } from "vitest";

// This test's own words are split so the search does not find itself.
const NEEDLE = `<${"iframe"}`;
const sources = import.meta.glob(["/src/**/*.{ts,tsx,html,css}", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("no iframes", () => {
  it("the search covers the app's source", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
    expect(Object.keys(sources).some((p) => p.endsWith("/features/hmdoc/blocks/embedViews.ts"))).toBe(true);
  });

  it(`no file under src/ holds ${NEEDLE}`, () => {
    const found = Object.entries(sources).filter(([, text]) => text.toLowerCase().includes(NEEDLE)).map(([path]) => path);
    expect(found).toEqual([]);
  });

  it("nor creates one from script", () => {
    const made = Object.entries(sources).filter(([, text]) => /createElement\(\s*["'`]iframe["'`]/i.test(text)).map(([path]) => path);
    expect(made).toEqual([]);
  });
});
