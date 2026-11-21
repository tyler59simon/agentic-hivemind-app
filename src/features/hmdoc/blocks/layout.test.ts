// NS-3D: the geometry of free-positioned blocks.
import { describe, expect, it } from "vitest";
import { blockHeight, frameOrder, frontZ, GRID, MIN_BLOCK_H, MIN_FRAME_H, MIN_FRAME_W, moved, newFrame, resized, snap } from "./layout";

const frame = { x: 16, y: 16, w: 160, h: 64, z: 1 };

describe("snapping", () => {
  it("rounds to the 8 px grid", () => {
    expect([0, 3, 4, 5, 8, 11, 12, 13, -3, -5].map(snap)).toEqual([0, 0, 8, 8, 8, 8, 16, 16, -0, -8]);
    expect(GRID).toBe(8);
  });

  it("a move snaps and never leaves the block's top or left edge", () => {
    expect(moved(frame, 13, 7)).toEqual({ ...frame, x: 32, y: 24 });
    expect(moved(frame, -100, -100)).toEqual({ ...frame, x: 0, y: 0 });
    expect(moved(frame, 0, 0)).toEqual(frame);
  });

  it("a resize snaps and keeps the minimum size", () => {
    expect(resized(frame, 13, 7)).toEqual({ ...frame, w: 176, h: 72 });
    expect(resized(frame, -1000, -1000)).toEqual({ ...frame, w: MIN_FRAME_W, h: MIN_FRAME_H });
  });
});

describe("the block's height", () => {
  it("grows to fit the lowest frame, and shrinks back to the minimum", () => {
    expect(blockHeight([])).toBe(MIN_BLOCK_H);
    expect(blockHeight([{ y: 16, h: 64 }])).toBe(MIN_BLOCK_H);
    expect(blockHeight([{ y: 16, h: 64 }, { y: 400, h: 100 }])).toBe(516);
    expect(blockHeight([{ y: 16, h: 64 }, { y: 24, h: 100 }])).toBe(MIN_BLOCK_H);
  });
});

describe("z order", () => {
  it("a frame already in front keeps its z; one behind goes one above the top", () => {
    expect(frontZ(5, [1, 2])).toBe(5);
    expect(frontZ(1, [1, 4, 2])).toBe(5);
    expect(frontZ(1, [])).toBe(1);
  });
});

describe("reading order", () => {
  it("is top to bottom, then left to right, then as the frames stand", () => {
    const frames = [{ x: 200, y: 16 }, { x: 16, y: 120 }, { x: 16, y: 16 }, { x: 200, y: 16 }];
    expect(frameOrder(frames)).toEqual([2, 0, 3, 1]);
    expect(frameOrder([])).toEqual([]);
  });
});

describe("a new frame", () => {
  it("is at the top left of an empty block and below the lowest frame otherwise, in front", () => {
    expect(newFrame([])).toEqual({ x: 16, y: 16, w: 320, h: 96, z: 1 });
    expect(newFrame([{ y: 16, h: 96, z: 3 }])).toEqual({ x: 16, y: 120, w: 320, h: 96, z: 4 });
  });
});
