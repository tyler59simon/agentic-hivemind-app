// Which terminal tab sits in which pane. Pure moves on a plain state, so they are testable without React; the store
// at the bottom persists the state as `hivemind.terms`. A terminal id is in at most one pane.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStorage } from "../../store";

export type Pane = 0 | 1;

export interface Layout {
  split: boolean;
  panes: [string[], string[]];
  active: [string | null, string | null];
  focus: Pane;
}

export const EMPTY: Layout = { split: false, panes: [[], []], active: [null, null], focus: 0 };

export const paneOf = (s: Layout, id: string): Pane | null => (s.panes[0].includes(id) ? 0 : s.panes[1].includes(id) ? 1 : null);

/** The tab to show after `id` leaves its pane: its right neighbour, else its left one, else nothing. */
function neighbour(pane: string[], id: string): string | null {
  const i = pane.indexOf(id);
  return pane[i + 1] ?? pane[i - 1] ?? null;
}

/** Every pane's active tab is one of its tabs (the first when it was not), or null when the pane is empty. */
function settle(s: Layout): Layout {
  const active = [0, 1].map((i) => {
    const a = s.active[i];
    return a !== null && s.panes[i].includes(a) ? a : s.panes[i][0] ?? null;
  }) as Layout["active"];
  return { ...s, active };
}

/** Without a second pane, everything is in the first. */
function unsplit(s: Layout): Layout {
  if (s.split) return s;
  if (s.panes[1].length === 0) return { ...s, focus: 0 };
  const fromSecond = s.focus === 1 ? s.active[1] : null;
  return settle({ split: false, panes: [[...s.panes[0], ...s.panes[1]], []], active: [fromSecond ?? s.active[0], null], focus: 0 });
}

/** Show `id` in the focused pane, or focus the pane that has it, and make it that pane's active tab. */
export function openIn(s: Layout, id: string): Layout {
  const have = paneOf(s, id);
  if (have !== null) return { ...s, active: s.active.map((a, i) => (i === have ? id : a)) as Layout["active"], focus: have };
  const at = s.split ? s.focus : 0;
  return {
    ...s,
    panes: s.panes.map((p, i) => (i === at ? [...p, id] : p)) as Layout["panes"],
    active: s.active.map((a, i) => (i === at ? id : a)) as Layout["active"],
    focus: at,
  };
}

/** Move a tab to the other pane and focus it there. Does nothing without a second pane. */
export function moveTab(s: Layout, id: string, to: Pane): Layout {
  const from = paneOf(s, id);
  if (!s.split || from === null || from === to) return s;
  const panes: Layout["panes"] = [[], []];
  panes[from] = s.panes[from].filter((x) => x !== id);
  panes[to] = [...s.panes[to], id];
  const active: Layout["active"] = [...s.active];
  if (active[from] === id) active[from] = neighbour(s.panes[from], id);
  active[to] = id;
  return settle({ ...s, panes, active, focus: to });
}

/** Remove a tab. A pane that loses its active tab shows the neighbour; focus stays where it was. */
export function closeTab(s: Layout, id: string): Layout {
  const from = paneOf(s, id);
  if (from === null) return s;
  const panes: Layout["panes"] = [...s.panes];
  panes[from] = s.panes[from].filter((x) => x !== id);
  const active: Layout["active"] = [...s.active];
  if (active[from] === id) active[from] = neighbour(s.panes[from], id);
  return settle({ ...s, panes, active });
}

/** Turn the second pane on or off. Turning it off merges its tabs into the first pane. */
export function toggleSplit(s: Layout): Layout {
  return s.split ? unsplit({ ...s, split: false }) : { ...s, split: true };
}

export function focusPane(s: Layout, pane: Pane): Layout {
  return s.split || pane === 0 ? { ...s, focus: pane } : s;
}

const same = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);

/** Make the layout match the tab list: drop ids that are gone, put new ones in the focused pane. */
export function reconcile(s: Layout, ids: string[]): Layout {
  const keep = new Set(ids);
  let next: Layout = { ...s, panes: [s.panes[0].filter((x) => keep.has(x)), s.panes[1].filter((x) => keep.has(x))] };
  const fresh = ids.filter((id) => paneOf(next, id) === null);
  if (fresh.length) {
    const at = next.split ? next.focus : 0;
    const panes: Layout["panes"] = [...next.panes];
    panes[at] = [...panes[at], ...fresh];
    next = { ...next, panes };
  }
  next = settle(unsplit(next));
  return same(next, s) ? s : next;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const idOrNull = (v: unknown) => v === null || typeof v === "string";

/** A stored layout that is not shaped right is replaced by the empty one. */
export function sane(v: unknown): Layout {
  const o = v as Partial<Layout> | null;
  if (!o || typeof o.split !== "boolean" || !Array.isArray(o.panes) || o.panes.length !== 2 || !strings(o.panes[0]) || !strings(o.panes[1])
    || !Array.isArray(o.active) || o.active.length !== 2 || !idOrNull(o.active[0]) || !idOrNull(o.active[1]) || (o.focus !== 0 && o.focus !== 1)) return EMPTY;
  const all = [...o.panes[0], ...o.panes[1]];
  if (new Set(all).size !== all.length) return EMPTY;
  return settle(unsplit(o as Layout));
}

export const useLayout = create<Layout>()(persist(() => EMPTY, {
  name: "hivemind.terms",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  partialize: (s): Layout => ({ split: s.split, panes: s.panes, active: s.active, focus: s.focus }),
  merge: (stored, current) => ({ ...current, ...sane(stored) }),
}));

/** Apply one of the moves above to the store. */
export function update(move: (s: Layout) => Layout): void {
  const { split, panes, active, focus } = useLayout.getState();
  useLayout.setState(move({ split, panes, active, focus }));
}
