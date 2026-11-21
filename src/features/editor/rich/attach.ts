// Pictures pasted into a page, dropped on it or picked from the toolbar become attachments, linked where they landed
// (NS-3A). A placeholder goes in at once and is replaced by the link when the attachment is saved, so typing meanwhile
// never moves the link; a placeholder the user deleted meanwhile gets no link.
import type { EditorView } from "@codemirror/view";
import type { RichContext } from "./context";
import { isPicture, pastedName } from "./parse";

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
};

/** The extension for a picture's MIME type, or null when Hivemind does not attach that kind. */
export const pictureExt = (mime: string) => EXT[mime.toLowerCase()] ?? null;

let counter = 0;

/** Put a placeholder for each item at `pos` (each on its own line when there are several), save each item, and swap
 *  each placeholder for the item's link. `save` resolves to the Markdown link. */
export async function attachAt(view: EditorView, ctx: RichContext, pos: number, names: string[], save: (i: number) => Promise<string>): Promise<void> {
  if (!names.length || view.state.readOnly) return;
  const marks = names.map((name) => `![Attaching ${name.replace(/[[\]]/g, "")} (${++counter})…]()`);
  const line = view.state.doc.lineAt(pos);
  const lead = pos > line.from && names.length > 1 ? "\n" : "";
  view.dispatch({ changes: { from: pos, insert: lead + marks.join("\n") }, selection: { anchor: pos + lead.length + marks.join("\n").length }, userEvent: "input.paste" });
  for (let i = 0; i < names.length; i++) {
    let link: string | null = null;
    try {
      link = await save(i);
    } catch (e) {
      ctx.fail(`${names[i]} was not attached: ${e instanceof Error ? e.message : String(e)}`);
    }
    const at = view.state.doc.toString().indexOf(marks[i]);
    if (at < 0) {
      if (link) ctx.fail(`${names[i]} was attached, but its placeholder was removed, so the page has no link to it.`);
      continue;
    }
    view.dispatch({ changes: { from: at, to: at + marks[i].length, insert: link ?? "" }, userEvent: "input.paste" });
  }
}

/** Pictures from the clipboard, named `Pasted image <time>.<ext>`. */
export function pastedPictures(data: DataTransfer | null, now = new Date()): { name: string; file: File }[] {
  if (!data) return [];
  const files = [...data.files].filter((f) => pictureExt(f.type));
  return files.map((file, i) => ({ name: pastedName(new Date(now.getTime() + i * 1000), pictureExt(file.type)!), file }));
}

/** Attach clipboard pictures at the selection. Returns whether the paste was a picture paste. */
export function pastePictures(view: EditorView, ctx: RichContext, data: DataTransfer | null): boolean {
  const attach = ctx.attach;
  const pictures = pastedPictures(data);
  if (!attach || !pictures.length || view.state.readOnly) return false;
  void attachAt(view, ctx, view.state.selection.main.head, pictures.map((p) => p.name),
    async (i) => attach(new Uint8Array(await pictures[i].file.arrayBuffer()), pictures[i].name));
  return true;
}

/** Attach the pictures of a drop at the drop point; returns the indexes taken. Other files are left to open. */
export function dropPictures(view: EditorView, ctx: RichContext, drop: { token: string; names: string[]; x: number; y: number }): number[] {
  const attach = ctx.attachDropped;
  if (!attach || view.state.readOnly) return [];
  const taken = drop.names.map((name, i) => (isPicture(name) ? i : -1)).filter((i) => i >= 0);
  if (!taken.length) return [];
  const pos = view.posAtCoords({ x: drop.x, y: drop.y }) ?? view.state.selection.main.head;
  void attachAt(view, ctx, pos, taken.map((i) => drop.names[i]), (n) => attach(drop.token, taken[n], drop.names[taken[n]]));
  return taken;
}
