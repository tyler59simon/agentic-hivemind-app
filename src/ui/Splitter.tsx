// A draggable divider between two regions side by side (DESK-LAYOUT), as the WAI-ARIA window splitter: a focusable
// `separator` that carries the value it sets. The caller says what the value is (rem, or a share in percent), its limits and
// how many pixels one unit is. Arrow keys move `step`, Shift+arrow `bigStep`, Home and End go to the limits and a double
// click resets. The hit area is 24 px wide and lies over the edge of the regions, so it takes no layout width.
import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { contextMenuKey, menuPointFor } from "./focus";

interface SplitterProps {
  /** The accessible name, such as "Sidebar width". */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  bigStep: number;
  /** How many CSS pixels one unit of `value` is, to turn a drag into a value. */
  pxPerUnit: number;
  /** The region grows when the divider moves left (a region on the right). */
  reverse?: boolean;
  /** `aria-valuetext`, when the number alone says too little. */
  text?: string;
  /** The id of the region this divider sizes (`aria-controls`). */
  controls?: string;
  onChange: (value: number) => void;
  onReset: () => void;
  /** A way to set the width without dragging (WCAG 2.5.7): the caller opens a menu where the pointer is, or under the divider
   *  from the keyboard (Shift+F10, the Menu key). */
  onMenu?: (at: { x: number; y: number }, from: HTMLElement) => void;
  className?: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round = (v: number) => Math.round(v * 100) / 100;

export function Splitter({ label, value, min, max, step, bigStep, pxPerUnit, reverse = false, text, controls, onChange, onReset, onMenu, className = "" }: SplitterProps) {
  // The pointer that is dragging, with where and at what value it started.
  const drag = useRef<{ id: number; x: number; value: number } | null>(null);
  const set = (v: number) => { const next = round(clamp(v, min, max)); if (next !== round(value)) onChange(next); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onMenu && contextMenuKey(e)) { e.preventDefault(); onMenu(menuPointFor(e.currentTarget), e.currentTarget); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const by = e.shiftKey ? bigStep : step;
    const sign = reverse ? -1 : 1;
    if (e.key === "ArrowRight") set(value + sign * by);
    else if (e.key === "ArrowLeft") set(value - sign * by);
    else if (e.key === "Home") set(min);
    else if (e.key === "End") set(max);
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // The first pointer keeps the drag until it ends: a second touch or button does not take it over.
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); // no text selection while dragging; the focus is given by hand
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, value };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || pxPerUnit <= 0) return;
    set(d.value + ((e.clientX - d.x) / pxPerUnit) * (reverse ? -1 : 1));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // Capture lost without a pointerup (the window lost it, the element went): the drag is over.
  const onLostCapture = (e: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === e.pointerId) drag.current = null; };
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!onMenu) return;
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY }, e.currentTarget);
  };

  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={round(value)} aria-valuemin={round(min)} aria-valuemax={round(max)}
      aria-valuetext={text} aria-controls={controls} tabIndex={0} className={`splitter ${className}`.trim()}
      onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      onLostPointerCapture={onLostCapture} onContextMenu={onContextMenu} onDoubleClick={onReset} />
  );
}
