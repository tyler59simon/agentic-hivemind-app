// A scrolling list of fixed-height rows that draws only the rows in view (NS-6B). A browser will not make an element taller
// than a few tens of millions of pixels, and a 200 MB log has millions of lines, so past `MAX_SPACE` the scroll bar covers
// the whole list at a smaller scale: the scroll position maps to a row by proportion instead of by row height.
import { useCallback, useEffect, useRef, useState } from "react";

/** The height of one row in pixels. */
export const ROW = 20;
/** The tallest the scrolling area is made. */
export const MAX_SPACE = 8_000_000;
/** The height assumed before the list is measured (and where the browser reports none). */
const DEFAULT_VIEW = 600;

/** The height of the scrolling area for `rows` rows. */
export const spaceHeight = (rows: number) => Math.min(rows * ROW, MAX_SPACE);

/** The row at the top of the view when the area is scrolled to `scrollTop`. */
export function firstRowAt(scrollTop: number, rows: number, view: number): number {
  if (rows <= 0) return 0;
  const full = rows * ROW, space = spaceHeight(rows);
  const first = full <= space ? Math.floor(scrollTop / ROW) : Math.floor((scrollTop / Math.max(1, space - view)) * Math.max(0, full - view) / ROW);
  return Math.max(0, Math.min(rows - 1, first));
}

/** The scroll position that puts `row` at the top of the view. */
export function scrollFor(row: number, rows: number, view: number): number {
  const full = rows * ROW, space = spaceHeight(rows);
  if (full <= space) return row * ROW;
  return (row * ROW / Math.max(1, full - view)) * Math.max(1, space - view);
}

export interface Windowed {
  /** Put on the scrolling element. */
  scroller: { ref: React.RefObject<HTMLDivElement | null>; onScroll: () => void };
  /** The first row to draw, how many, the height of the area, and the offset to draw them at. */
  first: number;
  count: number;
  space: number;
  offset: number;
  scrollTo: (row: number) => void;
  /** Scroll to the very end. */
  toEnd: () => void;
  /** Whether the view is at (or within a few rows of) the end. */
  atEnd: () => boolean;
  /** The last position the code itself scrolled to, so a scroll event it caused can be told from the user's. */
  moved: React.RefObject<number>;
}

/** The window of `rows` rows in the element `scroller` is put on. */
export function useWindowed(rows: number): Windowed {
  const ref = useRef<HTMLDivElement | null>(null);
  const moved = useRef(-1);
  const [top, setTop] = useState(0);
  const [view, setView] = useState(0);
  // Where the code last scrolled to and the row it meant: a scroll bar over millions of rows moves several rows to the
  // pixel, so the row stays the one asked for until the user scrolls.
  const [pin, setPin] = useState<{ row: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setView(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const px = view || DEFAULT_VIEW;
  const onScroll = useCallback(() => { if (ref.current) setTop(ref.current.scrollTop); }, []);
  const set = useCallback((value: number, row: number) => {
    const el = ref.current;
    if (!el) return;
    moved.current = value;
    el.scrollTop = value;
    setTop(value);
    setPin({ row, top: value });
  }, []);
  const space = spaceHeight(rows);
  const first = pin && Math.abs(top - pin.top) <= 2 ? Math.max(0, Math.min(rows - 1, pin.row)) : firstRowAt(top, rows, px);
  const scrollTo = useCallback((row: number) => {
    const at = Math.max(0, Math.min(rows - 1, row));
    set(scrollFor(at, rows, px), at);
  }, [rows, px, set]);
  const toEnd = useCallback(() => set(Math.max(0, space - px), Math.max(0, rows - Math.floor(px / ROW))), [rows, space, px, set]);
  const atEnd = useCallback(() => top + px >= space - 2 * ROW, [top, px, space]);
  const count = Math.min(rows - first, Math.ceil(px / ROW) + 2);
  return { scroller: { ref, onScroll }, first, count: Math.max(0, count), space, offset: rows * ROW <= MAX_SPACE ? first * ROW : top, scrollTo, toEnd, atEnd, moved };
}
