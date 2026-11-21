// NS-3D: the file steps of saving a drawing, with the notebook's file commands mocked. A new drawing attaches its preview
// and then creates the scene beside it; an edited one attaches a new preview, saves the scene against the hash it was read
// with, points the page at the new preview and only then moves the old one to the trash.
import { describe, expect, it, vi } from "vitest";
import type { Loaded, SaveOutcome, Stamp } from "../../../lib/notebooks";
import type { NotebookFiles } from "../../editor/rich/context";
import { commitDrawing, DrawingChanged, isOwnPreview, loadScene, timestamp } from "./drawing";

const FORMAT = { encoding: "utf-8", bom: false, eol: "lf" as const };
const stamp: Stamp = { sha256: "a".repeat(64), size: 10, mtimeMs: 5 };
const png = new Uint8Array([137, 80, 78, 71]);
const loaded = (text: string, binary = false) => ({ text, ...stamp, format: FORMAT, readOnly: null, binary }) as Loaded;

/** A notebook whose calls are logged in order. */
function notebook(over: Partial<NotebookFiles> = {}, log: string[] = []) {
  const nb: NotebookFiles = {
    files: [],
    url: () => null,
    read: vi.fn(async () => loaded('{"type":"excalidraw","elements":[]}')),
    create: vi.fn(async (path: string) => { log.push(`create ${path}`); return stamp; }),
    save: vi.fn(async (path: string): Promise<SaveOutcome> => { log.push(`save ${path}`); return { status: "saved", ...stamp }; }),
    trash: vi.fn(async (path: string) => { log.push(`trash ${path}`); }),
    ...over,
  };
  return nb;
}
/** An attach path that saves into `attachments/` under the name asked for. */
const attachTo = (log: string[]) => vi.fn(async (_bytes: Uint8Array, name: string) => { log.push(`attach ${name}`); return `attachments/${name}`; });

const NOW = () => new Date(2026, 10, 21, 15, 30, 12);

describe("a new drawing", () => {
  it("attaches the preview, then creates the scene with the preview's name; nothing is saved or trashed", async () => {
    const log: string[] = [];
    const nb = notebook({}, log);
    const attach = attachTo(log);
    const apply = vi.fn((next: { scene: string }) => { log.push(`apply ${next.scene}`); return true; });
    const done = await commitDrawing(nb, attach, { text: "{scene}", png, current: null, apply, stillUsed: () => false, now: NOW });
    expect(log).toEqual([
      "attach Drawing 20261121-153012.png",
      "create attachments/Drawing 20261121-153012.excalidraw",
      "apply attachments/Drawing 20261121-153012.excalidraw",
    ]);
    expect(attach).toHaveBeenCalledWith(png, "Drawing 20261121-153012.png");
    expect(nb.create).toHaveBeenCalledWith("attachments/Drawing 20261121-153012.excalidraw", "{scene}");
    expect(nb.save).not.toHaveBeenCalled();
    expect(nb.trash).not.toHaveBeenCalled();
    expect(done).toEqual({ scene: "attachments/Drawing 20261121-153012.excalidraw", preview: "attachments/Drawing 20261121-153012.png", applied: true, keptOld: false });
  });

  it("uses the name the attach path gave the preview, even when it numbered it", async () => {
    const nb = notebook();
    const attach = vi.fn(async () => "pics/Drawing 20261121-153012 1.png");
    const done = await commitDrawing(nb, attach, { text: "x", png, current: null, apply: () => true, stillUsed: () => false, now: NOW });
    expect(done.scene).toBe("pics/Drawing 20261121-153012 1.excalidraw");
  });

  it("when the scene cannot be created, the preview is trashed again and the page is not changed", async () => {
    const log: string[] = [];
    const nb = notebook({ create: vi.fn(async () => { throw new Error("exists"); }) }, log);
    const apply = vi.fn(() => true);
    await expect(commitDrawing(nb, attachTo(log), { text: "x", png, current: null, apply, stillUsed: () => false, now: NOW })).rejects.toThrow("exists");
    expect(log).toEqual(["attach Drawing 20261121-153012.png", "trash attachments/Drawing 20261121-153012.png"]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("when the preview cannot be attached, nothing else happens", async () => {
    const nb = notebook();
    await expect(commitDrawing(nb, vi.fn(async () => { throw new Error("too big"); }), { text: "x", png, current: null, apply: () => true, stillUsed: () => false })).rejects.toThrow("too big");
    expect(nb.create).not.toHaveBeenCalled();
    expect(nb.trash).not.toHaveBeenCalled();
  });
});

describe("an edited drawing", () => {
  const current = { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png", pre: stamp, format: FORMAT };

  it("attaches a new preview, saves the scene against the hash it was read with, points the page at it, then trashes the old preview", async () => {
    const log: string[] = [];
    const nb = notebook({}, log);
    const attach = vi.fn(async (_b: Uint8Array, name: string) => { log.push(`attach ${name}`); return "attachments/Sketch 1.png"; });
    const apply = vi.fn((next: { preview: string }) => { log.push(`apply ${next.preview}`); return true; });
    const done = await commitDrawing(nb, attach, { text: "{scene 2}", png, current, apply, stillUsed: () => false });
    expect(log).toEqual(["attach Sketch.png", "save attachments/Sketch.excalidraw", "apply attachments/Sketch 1.png", "trash attachments/Sketch.png"]);
    expect(nb.save).toHaveBeenCalledWith("attachments/Sketch.excalidraw", "{scene 2}", stamp, FORMAT);
    expect(nb.create).not.toHaveBeenCalled();
    expect(done).toEqual({ scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch 1.png", applied: true, keptOld: false });
  });

  it("keeps the old preview while another block of the page still shows it", async () => {
    const nb = notebook();
    await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 1.png"), { text: "x", png, current, apply: () => true, stillUsed: (p) => p === "attachments/Sketch.png" });
    expect(nb.trash).not.toHaveBeenCalled();
  });

  it("when the scene changed on disk, nothing is overwritten: the new preview is trashed, the page is left alone", async () => {
    const log: string[] = [];
    const nb = notebook({ save: vi.fn(async (): Promise<SaveOutcome> => ({ status: "stale", sha256: "b".repeat(64) })) }, log);
    const apply = vi.fn(() => true);
    const attach = vi.fn(async () => { log.push("attach"); return "attachments/Sketch 1.png"; });
    const error = await commitDrawing(nb, attach, { text: "x", png, current, apply, stillUsed: () => false }).catch((e) => e);
    expect(error).toBeInstanceOf(DrawingChanged);
    expect(error.gone).toBe(false);
    expect(log).toEqual(["attach", "trash attachments/Sketch 1.png"]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("a scene deleted meanwhile is reported as gone", async () => {
    const nb = notebook({ save: vi.fn(async (): Promise<SaveOutcome> => ({ status: "gone" })) });
    const error = await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 1.png"), { text: "x", png, current, apply: () => true, stillUsed: () => false }).catch((e) => e);
    expect(error).toBeInstanceOf(DrawingChanged);
    expect(error.gone).toBe(true);
    expect(nb.trash).toHaveBeenCalledWith("attachments/Sketch 1.png");
  });

  it("when the page can no longer take the files, the old preview stays", async () => {
    const nb = notebook();
    const done = await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 1.png"), { text: "x", png, current, apply: () => false, stillUsed: () => false });
    expect(done.applied).toBe(false);
    expect(nb.trash).not.toHaveBeenCalled();
  });

  it("F1: never trashes a picture that is not the drawing's own preview, whatever the page names", async () => {
    for (const other of ["pics/Holiday.png", "attachments/Holiday.png", "attachments/Sketch copy.png", "attachments/Sketch 1x.png", "other/Sketch.png", "attachments/Sketch.jpg", "attachments/sub/Sketch.png"]) {
      const nb = notebook();
      const done = await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 1.png"), { text: "x", png, current: { ...current, preview: other }, apply: () => true, stillUsed: () => false });
      expect(nb.trash, other).not.toHaveBeenCalled();
      expect(done.keptOld, other).toBe(false);
    }
  });

  it("F1: trashes the preview with the scene's stem, or its stem and a number, beside it", async () => {
    for (const own of ["attachments/Sketch.png", "attachments/Sketch 2.png", "attachments/Sketch 10.PNG"]) {
      const nb = notebook();
      await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 11.png"), { text: "x", png, current: { ...current, preview: own }, apply: () => true, stillUsed: () => false });
      expect(nb.trash, own).toHaveBeenCalledWith(own);
    }
  });

  it("an old preview that cannot be trashed is reported, not an error", async () => {
    const nb = notebook({ trash: vi.fn(async () => { throw new Error("locked"); }) });
    const done = await commitDrawing(nb, vi.fn(async () => "attachments/Sketch 1.png"), { text: "x", png, current, apply: () => true, stillUsed: () => false });
    expect(done).toMatchObject({ applied: true, keptOld: true });
  });
});

describe("a drawing's own preview", () => {
  it("is beside the scene and named with its stem, alone or with a number", () => {
    expect(isOwnPreview("a/S.excalidraw", "a/S.png")).toBe(true);
    expect(isOwnPreview("a/S.excalidraw", "a/S 3.png")).toBe(true);
    expect(isOwnPreview("S.excalidraw", "S 12.png")).toBe(true);
    for (const no of ["a/S.jpg", "a/T.png", "a/S3.png", "a/S .png", "a/S 3 4.png", "b/S.png", "S.png", "a/b/S.png", "a/S 3x.png"]) expect(isOwnPreview("a/S.excalidraw", no), no).toBe(false);
  });
});

describe("reading a scene", () => {
  it("gives the parsed scene and the stamp and format a later save is checked against", async () => {
    const scene = await loadScene(notebook(), "attachments/Sketch.excalidraw");
    expect(scene).toEqual({ stamp, format: FORMAT, data: { type: "excalidraw", elements: [] } });
  });

  it("refuses a file that is binary or not JSON", async () => {
    await expect(loadScene(notebook({ read: vi.fn(async () => loaded("", true)) }), "a.excalidraw")).rejects.toThrow("not a drawing");
    await expect(loadScene(notebook({ read: vi.fn(async () => loaded("{nope")) }), "a.excalidraw")).rejects.toThrow("not valid JSON");
  });
});

describe("the preview's name", () => {
  it("is the date and time, in local time", () => {
    expect(timestamp(new Date(2026, 0, 5, 3, 4, 9))).toBe("20260105-030409");
  });
});
