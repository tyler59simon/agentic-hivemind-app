// The geometry of a free-positioned block (NS-3D), without ProseMirror or the DOM, so extraction, export and tests share
// it. A frame is `{ x, y, w, h, z }` in pixels from the block's top left; moves and resizes snap to an 8 px grid.
export const GRID = 8;
export const MIN_FRAME_W = 64;
export const MIN_FRAME_H = 32;
/** The block never draws shorter than this, and keeps this margin below its lowest frame. */
export const MIN_BLOCK_H = 240;
export const BLOCK_MARGIN = 32;
/** The largest a stored number may be (the same bound `rules.ts` holds). */
const LIMIT = 100_000;

export interface Frame { x: number; y: number; w: number; h: number; z: number }

export const snap = (v: number): number => Math.round(v / GRID) * GRID;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** The largest multiple of the grid that is at most `v`: a limit that is not on the grid is rounded down to it, so a frame
 *  stopped at the block's edge is still on the grid. */
const down = (v: number) => Math.floor(v / GRID) * GRID;

/** A frame moved by `dx`, `dy` from `from`: snapped, and never left of or above the block, nor, when the block's `width`
 *  is known, past its right edge (a frame wider than the block goes to its left edge). */
export function moved(from: Frame, dx: number, dy: number, width?: number): Frame {
  const right = width ? Math.max(0, down(width - from.w)) : LIMIT;
  return { ...from, x: clamp(snap(from.x + dx), 0, right), y: clamp(snap(from.y + dy), 0, LIMIT) };
}

/** A frame whose bottom right corner moved by `dx`, `dy`: snapped, never smaller than the minimum, and when the block's
 *  `width` is known never past its right edge. */
export function resized(from: Frame, dx: number, dy: number, width?: number): Frame {
  const wide = width ? Math.max(MIN_FRAME_W, down(width - from.x)) : LIMIT;
  return { ...from, w: clamp(snap(from.w + dx), MIN_FRAME_W, wide), h: clamp(snap(from.h + dy), MIN_FRAME_H, LIMIT) };
}

/** The height a block needs for these frames: it grows to fit the lowest one and shrinks back when that one moves up. */
export function blockHeight(frames: readonly Pick<Frame, "y" | "h">[]): number {
  const bottom = frames.reduce((low, f) => Math.max(low, f.y + f.h), 0);
  return clamp(Math.max(MIN_BLOCK_H, bottom + BLOCK_MARGIN), 0, LIMIT);
}

/** The z a frame needs to be in front of the others: unchanged when it already is. */
export function frontZ(own: number, others: readonly number[]): number {
  const top = others.reduce((m, z) => Math.max(m, z), -1);
  return own > top ? own : Math.min(top + 1, LIMIT);
}

/** Reading order of frames, for extraction and export: top to bottom, then left to right, then as they stand in the
 *  document. Returns the indexes in that order. Frames snap to the grid, so equal rows compare equal. */
export function frameOrder(frames: readonly Pick<Frame, "x" | "y">[]): number[] {
  return frames.map((_, i) => i).sort((a, b) => frames[a].y - frames[b].y || frames[a].x - frames[b].x || a - b);
}

/** A place for a new frame: below the lowest one, or at the top left of an empty block. */
export function newFrame(frames: readonly Pick<Frame, "y" | "h" | "z">[], width?: number): Frame {
  const bottom = frames.reduce((low, f) => Math.max(low, f.y + f.h), 0);
  const z = frames.reduce((m, f) => Math.max(m, f.z), 0) + 1;
  const x = GRID * 2;
  return { x, y: frames.length ? snap(bottom + GRID) : GRID * 2, w: width ? clamp(down(width - x), MIN_FRAME_W, 320) : 320, h: 96, z: Math.min(z, LIMIT) };
}
