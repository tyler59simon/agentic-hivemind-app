// Saving a drawing (NS-3D), without Excalidraw or the DOM so the file steps can be tested with mocked file commands.
// A drawing is two files of the page's notebook: the scene (`Name.excalidraw`, JSON) and a PNG preview that stands for it
// in the page. Both are in the attachments folder (the preview is saved through the page's attach path, which chooses the
// folder and never replaces a file), and the scene has the preview's name with its own extension.
//
// New drawing: the preview is attached, then the scene is created beside it. Nothing is written until Done.
// Edited drawing: a new preview is attached, then the scene is saved against the hash it was read with; the preview it
// replaces goes to the notebook's trash once the page points at the new one. A scene that changed on disk meanwhile is
// never overwritten: the new preview is trashed again and the caller offers a new drawing instead.
import type { Stamp, FileFormat } from "../../../lib/notebooks";
import type { NotebookFiles } from "../../editor/rich/context";

export interface Drawing { scene: string; preview: string }

export type Attach = (bytes: Uint8Array, name: string) => Promise<string>;

/** The scene file is not the one that was opened: it changed on disk, or is gone. */
export class DrawingChanged extends Error {
  constructor(readonly gone: boolean) {
    super(gone ? "The drawing file is gone." : "The drawing file changed on disk since it was opened.");
    this.name = "DrawingChanged";
  }
}

export interface LoadedScene { stamp: Stamp; format: FileFormat; data: unknown }

/** Read a scene: its content as parsed JSON, and the stamp and format a later save is checked against. */
export async function loadScene(nb: NotebookFiles, scene: string): Promise<LoadedScene> {
  const file = await nb.read(scene);
  if (file.binary) throw new Error(`${scene} is not a drawing`);
  let data: unknown;
  try {
    data = JSON.parse(file.text);
  } catch {
    throw new Error(`${scene} is not a drawing (it is not valid JSON)`);
  }
  return { stamp: { sha256: file.sha256, size: file.size, mtimeMs: file.mtimeMs }, format: file.format, data };
}

/** `20261121-153012`, in local time. */
export function timestamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

const stemOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]*$/, "");
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/** Whether `preview` is the scene's own preview: beside the scene, named with its stem or its stem and a number (the
 *  attach path's numbering). A page is untrusted input, so a block can name any picture of the notebook as its preview, and
 *  only a file that looks like this one's own may be moved to the trash when the drawing is edited. */
export function isOwnPreview(scene: string, preview: string): boolean {
  if (folderOf(scene) !== folderOf(preview) || !/\.png$/i.test(preview)) return false;
  const stem = stemOf(scene), name = stemOf(preview);
  return name === stem || (name.startsWith(`${stem} `) && /^\d+$/.test(name.slice(stem.length + 1)));
}

export interface Commit {
  /** The scene as Excalidraw writes it, and the preview PNG. */
  text: string;
  png: Uint8Array;
  /** The drawing being edited, with what its scene was read as; null for a new drawing. */
  current: (Drawing & { pre: Stamp; format: FileFormat }) | null;
  /** Make the page point at the new files. False when the page can no longer take them (it was closed, or the drawing's
   *  block is gone). */
  apply(next: Drawing): boolean;
  /** Whether the page still points at this preview after `apply`. */
  stillUsed(preview: string): boolean;
  now?: () => Date;
}

export interface Committed extends Drawing {
  /** The page took the new files. */
  applied: boolean;
  /** The preview this one replaced could not be moved to the trash. */
  keptOld: boolean;
}

export async function commitDrawing(nb: NotebookFiles, attach: Attach, c: Commit): Promise<Committed> {
  const name = c.current ? `${stemOf(c.current.scene)}.png` : `Drawing ${timestamp((c.now ?? (() => new Date()))())}.png`;
  const preview = await attach(c.png, name);
  let scene: string;
  try {
    if (c.current) {
      scene = c.current.scene;
      const out = await nb.save(scene, c.text, c.current.pre, c.current.format);
      if (out.status !== "saved") throw new DrawingChanged(out.status === "gone");
    } else {
      scene = preview.replace(/\.png$/i, ".excalidraw");
      await nb.create(scene, c.text);
    }
  } catch (e) {
    // The preview was never pointed at: it must not stay behind.
    await nb.trash(preview).catch(() => undefined);
    throw e;
  }
  const applied = c.apply({ scene, preview });
  let keptOld = false;
  if (applied && c.current && c.current.preview !== preview && isOwnPreview(c.current.scene, c.current.preview) && !c.stillUsed(c.current.preview)) {
    keptOld = await nb.trash(c.current.preview).then(() => false, () => true);
  }
  return { scene, preview, applied, keptOld };
}
