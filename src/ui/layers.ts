// Escape closes the top layer only (DESK-4): a dialog opened over a dialog, a menu opened in a dialog. Every dialog, menu
// and popup that Escape closes registers here instead of listening on the window itself, so one Escape never closes
// two of them.
import { useLayoutEffect, useRef } from "react";

interface Layer { id: number; close: () => void; locked: () => boolean }

const stack: Layer[] = [];
let next = 1;
let listening = false;

function onKey(e: KeyboardEvent): void {
  // A field or an editor that used Escape itself (closing its own completion list) has the last word.
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  if (!top.locked()) top.close();
}

/** Put a layer on top. Returns its id and the function that takes it off again, wherever it is in the stack. */
export function pushLayer(close: () => void, locked: () => boolean = () => false): { id: number; pop: () => void } {
  if (!listening && typeof window !== "undefined") { window.addEventListener("keydown", onKey); listening = true; }
  const layer = { id: next++, close, locked };
  stack.push(layer);
  return { id: layer.id, pop: () => { const i = stack.findIndex((l) => l.id === layer.id); if (i >= 0) stack.splice(i, 1); } };
}

export const isTopLayer = (id: number): boolean => stack.length > 0 && stack[stack.length - 1].id === id;
export const anyLayer = (): boolean => stack.length > 0;

/** A layer for as long as the component is mounted and `active`. The latest `onClose` and `locked` are used, so callers
 *  can pass inline functions. Returns a ref to the layer id (0 while inactive). */
export function useLayer(active: boolean, onClose: () => void, locked = false): { current: number } {
  const close = useRef(onClose);
  const isLocked = useRef(locked);
  close.current = onClose;
  isLocked.current = locked;
  const id = useRef(0);
  useLayoutEffect(() => {
    if (!active) return;
    const layer = pushLayer(() => close.current(), () => isLocked.current);
    id.current = layer.id;
    return () => { layer.pop(); id.current = 0; };
  }, [active]);
  return id;
}
