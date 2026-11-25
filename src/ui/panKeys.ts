// Panning a drawing from the keyboard (WCAG 2.5.7: dragging is not the only way). A viewport that has the focus itself takes
// the arrow keys; a key pressed on a control inside it (a card, a button) keeps its own meaning.
import type { KeyboardEvent } from "react";

/** The distance one arrow key pans, and the distance with Shift held, in screen pixels. */
export const PAN_STEP = 40;
export const PAN_STEP_FAR = 200;

/** Read by a screen reader when the viewport takes the focus (`aria-describedby`). */
export const PAN_HINT = `Press the arrow keys to pan by ${PAN_STEP} pixels, or hold Shift to pan by ${PAN_STEP_FAR}.`;

/** How far the drawing moves for this key: the way a scroll bar would, so the Down arrow shows what is below (the drawing
 *  moves up). Null when the key is not a pan key, the target is a control inside the viewport, or a modifier other than Shift is held. */
export function panDelta(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "target" | "currentTarget">): { dx: number; dy: number } | null {
  if (e.target !== e.currentTarget || e.ctrlKey || e.altKey || e.metaKey) return null;
  const step = e.shiftKey ? PAN_STEP_FAR : PAN_STEP;
  switch (e.key) {
    case "ArrowLeft": return { dx: step, dy: 0 };
    case "ArrowRight": return { dx: -step, dy: 0 };
    case "ArrowUp": return { dx: 0, dy: step };
    case "ArrowDown": return { dx: 0, dy: -step };
    default: return null;
  }
}
