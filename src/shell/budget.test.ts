// The width budget (DESK-LAYOUT): the widths drawn from the widths saved, at the window sizes that matter, pure.
import { describe, expect, it } from "vitest";
import { autoRail, effectiveLayout, LIMITS, paneShares, PANE_MIN_REM, type BudgetInput } from "./budget";

/** Every region at its largest, the rail open, on the Notes page with one pane, in a window of `viewport` CSS px. */
const maxima = (viewport: number, extra: Partial<BudgetInput> = {}): BudgetInput => ({
  viewport, rootPx: 16, sidebar: LIMITS.sidebar.max, tree: LIMITS.tree.max, rail: LIMITS.rail.max,
  collapsed: false, focus: false, treeShown: true, railOpen: true, panes: 1, ...extra,
});
const total = (b: ReturnType<typeof effectiveLayout>) => b.sidebar + b.tree + b.rail;

describe("the widths drawn", () => {
  it("are the saved widths when there is room (2560 px)", () => {
    const b = effectiveLayout(maxima(2560));
    expect(b).toMatchObject({ folded: false, overlay: false, sidebar: 24, tree: 28, rail: 32, workspaceMin: 14 });
    expect(b.max).toEqual({ sidebar: 24, tree: 28, rail: 32 });
  });

  it("shrink the rail first, then the notes list, then the sidebar, and never below their least (1440 px, all maxima)", () => {
    const b = effectiveLayout(maxima(1440)); // 90 rem; the notes keep 14, so 76 for 84 wanted
    expect(b.rail).toBeCloseTo(24, 5);
    expect(b.tree).toBe(28);
    expect(b.sidebar).toBe(24);
    expect(90 - total(b)).toBeCloseTo(14, 5);
  });

  it("keeps the notes at their minimum just above the rail breakpoint (1101 px, all maxima, rail open)", () => {
    const b = effectiveLayout(maxima(1101)); // 68.8 rem (1101 / 16)
    expect(b.overlay).toBe(false);
    expect(b.rail).toBe(LIMITS.rail.min);
    expect(b.tree).toBeCloseTo(1101 / 16 - 14 - 24 - 15, 5); // 15.8
    expect(b.sidebar).toBe(24);
    expect(1101 / 16 - total(b)).toBeCloseTo(14, 5);
  });

  it("is the same with the rail closed, and then the notes list keeps what the rail would have taken (1101 px)", () => {
    const b = effectiveLayout(maxima(1101, { railOpen: false }));
    expect(b.rail).toBe(0);
    expect(b.overlay).toBe(false);
    expect(b.sidebar).toBe(24);
    expect(b.tree).toBe(28); // 30.8 free, held to its own limit
  });

  it("shrinks the sidebar last, when the notes list is already at its least", () => {
    const b = effectiveLayout(maxima(1101, { sidebar: 24, tree: 24, rail: 32, panes: 2 })); // 68.8 rem (1101 / 16), the notes keep 28
    expect(b.workspaceMin).toBe(28);
    expect(b.rail).toBe(15);
    expect(b.tree + b.sidebar).toBeCloseTo(1101 / 16 - 28 - 15, 5);
    expect(b.tree).toBe(12);
    expect(b.sidebar).toBeCloseTo(1101 / 16 - 28 - 15 - 12, 5);
  });

  it("puts the rail over the note in a narrow window (1100 px and under) and gives it no width beside it", () => {
    for (const viewport of [1100, 1000, 961]) {
      const b = effectiveLayout(maxima(viewport));
      expect(b.overlay, `${viewport}`).toBe(true);
      expect(b.rail, `${viewport}`).toBe(0);
      expect(b.folded, `${viewport}`).toBe(false);
    }
  });

  it("folds the sidebar to icons and the notes list to 13 rem under 960 px, whatever was saved (800 px)", () => {
    const b = effectiveLayout(maxima(800));
    expect(b).toMatchObject({ folded: true, overlay: true, sidebar: 4.2, tree: 13, rail: 0 });
    expect(effectiveLayout(maxima(960)).folded).toBe(true);
    expect(effectiveLayout(maxima(961)).folded).toBe(false);
  });

  it("uses 4.2 rem for a collapsed sidebar and gives the room to the rest", () => {
    const wide = effectiveLayout(maxima(1440, { collapsed: true }));
    expect(wide.sidebar).toBe(4.2);
    expect(wide.tree).toBe(28);
    expect(wide.rail).toBe(32); // 90 - 14 - 4.2 - 28 = 43.8 is more than its limit
  });

  it("draws nothing in focus mode", () => {
    expect(effectiveLayout(maxima(1440, { focus: true }))).toMatchObject({ sidebar: 0, tree: 0, rail: 0 });
  });

  it("has no notes list or rail on a page that has none", () => {
    expect(effectiveLayout(maxima(1440, { treeShown: false, railOpen: false }))).toMatchObject({ tree: 0, rail: 0, sidebar: 24 });
  });

  it("follows the rail default until it is set: 24 vw between 15 and 25 rem", () => {
    expect(autoRail(1440, 16)).toBeCloseTo(21.6, 5);
    expect(autoRail(1101, 16)).toBeCloseTo(16.5, 1);
    expect(autoRail(3000, 16)).toBe(25);
    expect(effectiveLayout(maxima(1440, { rail: null })).rail).toBeCloseTo(21.6, 4);
  });

  it("repairs a width that is not a number or is out of its limits", () => {
    expect(effectiveLayout(maxima(2560, { sidebar: Number.NaN, tree: 1, rail: 400 }))).toMatchObject({ sidebar: 15.4, tree: 12, rail: 32 });
  });
});

describe("the widths at 200% zoom (1 rem is 32 px)", () => {
  it("1440 px is 45 rem: the rail goes over the note and the rest shrinks to leave the notes their minimum", () => {
    const b = effectiveLayout(maxima(1440, { rootPx: 32 }));
    expect(b.overlay).toBe(true); // 45 - 12 - 12 - 15 is less than 14
    expect(b.rail).toBe(0);
    expect(b.tree).toBe(12);
    expect(b.sidebar).toBeCloseTo(45 - 14 - 12, 5);
    expect(45 - total(b)).toBeCloseTo(14, 5);
  });

  it("2560 px is 80 rem: everything fits beside the note", () => {
    const b = effectiveLayout(maxima(2560, { rootPx: 32 }));
    expect(b.overlay).toBe(false);
    expect(80 - total(b)).toBeGreaterThanOrEqual(14 - 1e-9);
    expect(b.rail).toBeGreaterThanOrEqual(15);
  });

  it("with two panes the notes keep two minimums", () => {
    const b = effectiveLayout(maxima(2560, { rootPx: 32, panes: 2 }));
    expect(80 - total(b)).toBeGreaterThanOrEqual(28 - 1e-9);
  });

  it("never draws a region under its least, even when the notes get less than their minimum", () => {
    const b = effectiveLayout(maxima(1000, { rootPx: 32 })); // 31 rem
    expect(b.sidebar).toBeGreaterThanOrEqual(12);
    expect(b.tree).toBeGreaterThanOrEqual(12);
  });
});

describe("the room left to drag into", () => {
  it("is what the region has plus what is free, held to its limit", () => {
    const b = effectiveLayout(maxima(1440, { sidebar: 14, tree: 14, rail: 15 })); // 90 rem; 43 used, 76 for the regions
    expect(b.max.sidebar).toBe(24);
    expect(b.max.tree).toBe(28); // 14 + 33 free, held to its limit
  });

  it("is what it has when the window is full", () => {
    const b = effectiveLayout(maxima(1101));
    expect(b.max.sidebar).toBe(24);
    expect(b.max.tree).toBeCloseTo(b.tree, 5);
    expect(b.max.rail).toBe(15);
  });
});

describe("paneShares", () => {
  it("are the saved weights as fractions when every pane has its minimum", () => {
    expect(paneShares([1, 3], 60, PANE_MIN_REM)).toEqual([0.25, 0.75]);
  });

  it("raise a pane that would have too little to the minimum and take it from the others", () => {
    const [a, b] = paneShares([1, 3], 40, PANE_MIN_REM); // 25% of 40 rem is 10
    expect(a * 40).toBeCloseTo(14, 5);
    expect(b * 40).toBeCloseTo(26, 5);
  });

  it("settles three panes where two are small", () => {
    const s = paneShares([0.1, 0.1, 2.8], 50, PANE_MIN_REM);
    expect(s.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    expect(s[0] * 50).toBeCloseTo(14, 5);
    expect(s[1] * 50).toBeCloseTo(14, 5);
    expect(s[2] * 50).toBeCloseTo(22, 5);
  });

  it("are equal when the minimums cannot fit, and the weights when the width is not known", () => {
    expect(paneShares([1, 3], 20, PANE_MIN_REM)).toEqual([0.5, 0.5]);
    expect(paneShares([1, 3], 0, PANE_MIN_REM)).toEqual([0.25, 0.75]);
  });
});
