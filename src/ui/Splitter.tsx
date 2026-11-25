// A draggable divider between two regions side by side (DESK-LAYOUT), as the WAI-ARIA window splitter: a focusable
// `separator` that carries the value it sets. The caller says what the value is (rem, or a share in percent), its limits and
// how many pixels one unit is. Arrow keys move `step`, Shift+arrow `bigStep`, Home and End go to the limits and a double
// click resets. The hit area is 24 px wide and lies over the edge of the regions, so it takes no layout width.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";

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
  onChange: (value: number) => void;
  onReset: () => void;
  className?: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round = (v: number) => Math.round(v * 100) / 100;

export function Splitter({ label, value, min, max, step, bigStep, pxPerUnit, reverse = false, text, onChange, onReset, className = "" }: SplitterProps) {
  // The pointer that is dragging, with where and at what value it started.
  const drag = useRef<{ id: number; x: number; value: number } | null>(null);
  const set = (v: number) => { const next = round(clamp(v, min, max)); if (next !== round(value)) onChange(next); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
    if (e.button !== 0) return;
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
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={round(value)} aria-valuemin={round(min)} aria-valuemax={round(max)}
      aria-valuetext={text} tabIndex={0} className={`splitter ${className}`.trim()}
      onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      onDoubleClick={onReset} />
  );
}
