// The width budget of the window (DESK-LAYOUT): the widths the user saved for the sidebar, the notes list and the context rail
// are wishes. What is drawn is worked out here, in one pure function, so the CSS variables, the splitters and the tests all
// read the same numbers. The notes keep at least a workspace minimum; when the regions want more than is left they shrink in a
// fixed order (rail, then notes list, then sidebar), never below their own minimums, and a rail that cannot fit even at its
// minimum is shown over the note instead, as it is in a narrow window.

/** The least width of a pane, in rem. */
export const PANE_MIN_REM = 14;
/** The window widths (CSS px) where App.css folds the sidebar to icons and moves the rail over the note. */
export const ICON_ONLY_PX = 960;
export const RAIL_OVERLAY_PX = 1100;
/** The widths of the folded sidebar and of the notes list under 960 px (App.css), in rem. */
export const ICON_SIDEBAR_REM = 4.2;
export const FOLDED_TREE_REM = 13;

/** The width limits of each region in rem. */
export const LIMITS = {
  sidebar: { min: 12, max: 24 },
  tree: { min: 12, max: 28 },
  rail: { min: 15, max: 32 },
} as const;

/** The width a region has until the user drags it, in rem: what App.css had before. The rail has none: it follows the window,
 *  `clamp(15rem, 24vw, 25rem)` (see `autoRail`). */
export const DEFAULT_WIDTH = { sidebar: 15.4, tree: 16 } as const;

export type Region = keyof typeof LIMITS;

/** `value` held between the limits of `region`; anything that is not a finite number gives `fallback`. */
export function clampWidth(region: Region, value: unknown, fallback: number = LIMITS[region].min): number {
  const { min, max } = LIMITS[region];
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** The rail's width in rem when the user has not set one: 24 vw held between 15 and 25 rem, as the CSS clamp says. */
export const autoRail = (viewport: number, rootPx: number): number => Math.min(25, Math.max(15, (0.24 * viewport) / rootPx));

export interface BudgetInput {
  /** The window width in CSS px, and the size of 1 rem in CSS px. */
  viewport: number;
  rootPx: number;
  /** What the user saved, in rem; the rail is null until the user sets it. */
  sidebar: number;
  tree: number;
  rail: number | null;
  collapsed: boolean;
  focus: boolean;
  /** Whether the notes list is on the page, whether the rail is open beside the note, and how many panes are open. */
  treeShown: boolean;
  railOpen: boolean;
  panes: number;
}

export interface Budget {
  /** The sidebar is folded to icons by the window width (the user cannot size it). */
  folded: boolean;
  /** The rail lies over the note instead of beside it. */
  overlay: boolean;
  /** The widths drawn, in rem. A region that is not shown has 0. */
  sidebar: number;
  tree: number;
  rail: number;
  /** What the notes keep at least, in rem. */
  workspaceMin: number;
  /** How far each region can be dragged now: its limit, or what is free beyond what it has. */
  max: Record<Region, number>;
}

export function effectiveLayout(i: BudgetInput): Budget {
  const rem = (i.viewport / i.rootPx);
  const workspaceMin = Math.min(Math.max(i.panes, 1), 2) * PANE_MIN_REM;
  const folded = i.viewport <= ICON_ONLY_PX;
  const sidebarMin = i.collapsed || folded ? ICON_SIDEBAR_REM : LIMITS.sidebar.min;
  const treeMin = i.treeShown ? (folded ? FOLDED_TREE_REM : LIMITS.tree.min) : 0;
  // The rail goes over the note in a narrow window, and when it could not fit beside the note even with every region at its
  // least. This does not depend on whether it is open now, so opening it never changes where it is.
  const overlay = i.viewport <= RAIL_OVERLAY_PX || rem - sidebarMin - treeMin - LIMITS.rail.min < workspaceMin;
  if (i.focus) return { folded, overlay, sidebar: 0, tree: 0, rail: 0, workspaceMin, max: { sidebar: LIMITS.sidebar.max, tree: LIMITS.tree.max, rail: LIMITS.rail.max } };
  if (folded) return { folded, overlay, sidebar: ICON_SIDEBAR_REM, tree: treeMin, rail: 0, workspaceMin, max: { sidebar: LIMITS.sidebar.max, tree: LIMITS.tree.max, rail: LIMITS.rail.max } };

  let sidebar = i.collapsed ? ICON_SIDEBAR_REM : clampWidth("sidebar", i.sidebar, DEFAULT_WIDTH.sidebar);
  let tree = i.treeShown ? clampWidth("tree", i.tree, DEFAULT_WIDTH.tree) : 0;
  let rail = i.railOpen && !overlay ? clampWidth("rail", i.rail ?? autoRail(i.viewport, i.rootPx)) : 0;
  let over = sidebar + tree + rail - (rem - workspaceMin);
  const take = (width: number, least: number) => { const by = Math.max(0, Math.min(over, width - least)); over -= by; return width - by; };
  if (rail) rail = take(rail, LIMITS.rail.min);
  if (tree) tree = take(tree, treeMin);
  if (!i.collapsed) sidebar = take(sidebar, sidebarMin);
  const free = Math.max(0, rem - workspaceMin - sidebar - tree - rail);
  return {
    folded, overlay, sidebar, tree, rail, workspaceMin,
    max: {
      sidebar: Math.min(LIMITS.sidebar.max, sidebar + free),
      tree: Math.min(LIMITS.tree.max, tree + free),
      rail: Math.min(LIMITS.rail.max, Math.max(rail, LIMITS.rail.min) + free),
    },
  };
}

/** How the row of panes is shared, as fractions that add up to 1. `weights` are the panes' saved sizes. Each pane keeps at least
 *  `minRem` of the `totalRem` they share; a pane that would have less gets the minimum and the others share the rest in
 *  proportion. When even the minimums do not fit (or the width is not known) the weights decide, or all panes are equal. */
export function paneShares(weights: number[], totalRem: number, minRem: number): number[] {
  const n = weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const plain = weights.map((w) => (sum > 0 ? w / sum : 1 / n));
  if (!(totalRem > 0)) return plain;
  if (n * minRem > totalRem) return weights.map(() => 1 / n);
  const floor = minRem / totalRem;
  const pinned = new Set<number>();
  let shares = plain;
  for (let round = 0; round < n; round++) {
    const rest = 1 - pinned.size * floor;
    const free = plain.reduce((a, w, i) => a + (pinned.has(i) ? 0 : w), 0);
    shares = plain.map((w, i) => (pinned.has(i) ? floor : (w / free) * rest));
    const low = shares.findIndex((s, i) => !pinned.has(i) && s < floor - 1e-9);
    if (low < 0) break;
    pinned.add(low);
  }
  return shares;
}
