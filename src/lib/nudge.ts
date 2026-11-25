// Moving and resizing a shape with the keyboard, for the boards that otherwise need a drag (WCAG 2.5.7, DESK-A11Y A3). The
// canvas and the draw.io board share it. With a shape focused, Ctrl+Arrow (Cmd on macOS) moves it and Ctrl+Shift+Arrow resizes
// it by KEY_STEP in the arrow's direction; the registry (shortcuts.ts) has no entry because the keys act only on a focused shape.
// Alt+Arrow would be the natural pair, but Alt+Left is Back.

/** How far one key press moves or resizes a shape, in the board's own units (pixels at 100% zoom). */
export const KEY_STEP = 8;

export interface NudgeKey { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

const DIRECTION: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** What a key press asks of the focused shape: the change in x and y, as a move or a resize (the bottom right corner dragged by
 *  that much, so Right and Down grow it and Left and Up shrink it). Null when the key is not one of these. */
export function nudgeOf(e: NudgeKey): { kind: "move" | "resize"; dx: number; dy: number } | null {
  const d = DIRECTION[e.key];
  if (!d || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  return { kind: e.shiftKey ? "resize" : "move", dx: d[0] * KEY_STEP, dy: d[1] * KEY_STEP };
}

/** How soon after the last press the next press of a keyboard move or resize still joins its undo step. */
export const MERGE_MS = 1000;

/** The kind and time of the last commit of an editor, when it was a keyboard move or resize. */
export type Run = { group: string; at: number } | null;

/** Whether a commit of kind `group` (the same kind of keyboard move or resize as the last, within MERGE_MS) joins the history step
 *  of the last one, so holding an arrow key is one undo and not one per repeat. Records this commit as the last. */
export function joinsRun(run: { current: Run }, group: string | undefined, now = Date.now()): boolean {
  const joined = !!group && run.current?.group === group && now - run.current.at < MERGE_MS;
  run.current = group ? { group, at: now } : null;
  return joined;
}
