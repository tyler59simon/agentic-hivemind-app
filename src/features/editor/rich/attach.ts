// Pictures pasted into a page, dropped on it or picked from the toolbar become attachments, linked where they landed
// (NS-3A). While one is saved, a marker shows where its link goes; the marker is a widget, never text, so the page as
// saved, a draft or an undo never holds a placeholder (Codex review of 398b956, P2). The marker follows edits around
// it; a marker whose text the user deleted gets no link, and a page closed meanwhile gets the link on the clipboard.
import { Prec, StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import type { RichContext } from "./context";
import { isPicture, pastedName } from "./parse";

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
};

/** The extension for a picture's MIME type, or null when Hivemind does not attach that kind. */
export const pictureExt = (mime: string) => EXT[mime.toLowerCase()] ?? null;

class AttachingWidget extends WidgetType {
  constructor(readonly name: string) { super(); }
  eq(o: AttachingWidget) { return o.name === this.name; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-attaching";
    span.textContent = `Attaching ${this.name}…`;
    return span;
  }
}

type Marker = { id: number; batch: number; pos: number; name: string };
const addPending = StateEffect.define<Marker[]>();
/** Markers Undo took away: their attachments get no link. */
const cancelPending = StateEffect.define<number[]>();
/** One attachment is done: its marker goes, and the batch's other markers move to `to` (after its link) when given. */
const endPending = StateEffect.define<{ id: number; batch: number; to?: number }>();

/** The markers of attachments being saved. Before the cursor (side -1), so typing meanwhile goes after the link. */
export const pendingAttachments = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addPending)) {
        set = set.update({ add: e.value.map((p) => Decoration.widget({ widget: new AttachingWidget(p.name), side: -1, id: p.id, batch: p.batch }).range(p.pos)), sort: true });
      } else if (e.is(cancelPending)) {
        const ids = e.value;
        set = set.update({ filter: (_f, _t, d) => !ids.includes(d.spec.id) });
      } else if (e.is(endPending)) {
        const { id, batch, to } = e.value;
        const moved: Range<Decoration>[] = [];
        set = set.update({
          filter: (_f, _t, d) => {
            if (d.spec.id === id) return false;
            if (to !== undefined && d.spec.batch === batch) { moved.push(d.range(to)); return false; }
            return true;
          },
        });
        if (moved.length) set = set.update({ add: moved, sort: true });
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const closed = new WeakSet<EditorView>();
/** Notes which editors are gone, so an attachment finishing later does not write to one. */
const closing = ViewPlugin.define((view) => ({ destroy() { closed.add(view); } }));

/** Undo while pictures are being saved cancels their links and undoes nothing else; the markers never enter the undo
 *  history, so once a link is in, Undo removes it and the next Undo goes on to earlier edits (Codex re-reviews of
 *  87a0a1f and fd7109e). */
function cancelPendingUndo(view: EditorView): boolean {
  const ids: number[] = [];
  view.state.field(pendingAttachments, false)?.between(0, view.state.doc.length, (_f, _t, d) => { ids.push(d.spec.id); });
  if (!ids.length) return false;
  view.dispatch({ effects: cancelPending.of(ids) });
  return true;
}
// Undo's own transactions skip filters, so the keys and the browser's undo input are caught before the history's.
const undoCancels = Prec.highest([
  keymap.of([{ key: "Mod-z", run: cancelPendingUndo, preventDefault: true }]),
  EditorView.domEventHandlers({
    beforeinput: (e, view) => {
      if (e.inputType !== "historyUndo" || !cancelPendingUndo(view)) return false;
      e.preventDefault();
      return true;
    },
  }),
]);

/** What attaching needs in the editor: the markers, Undo for them, and the note of closed editors. */
export const attaching = [pendingAttachments, undoCancels, closing];

/** Where the marker `id` is now, or null when it is gone. */
function markerAt(state: EditorState, id: number): number | null {
  let at: number | null = null;
  state.field(pendingAttachments, false)?.between(0, state.doc.length, (from, _to, d) => {
    if (d.spec.id === id) { at = from; return false; }
  });
  return at;
}

let counter = 0;

/** Put a marker for each item at `pos`, save each item, and put each item's link where its marker is then (each on
 *  its own line when there are several). `save` resolves to the Markdown link. */
export async function attachAt(view: EditorView, ctx: RichContext, pos: number, names: string[], save: (i: number) => Promise<string>): Promise<void> {
  if (!names.length || view.state.readOnly) return;
  const batch = ++counter;
  const ids = names.map(() => ++counter);
  const line = view.state.doc.lineAt(pos);
  const lead = pos > line.from && names.length > 1 ? "\n" : "";
  view.dispatch({ effects: addPending.of(names.map((name, i) => ({ id: ids[i], batch, pos, name: name.replace(/[[\]]/g, "") }))) });
  let linked = false;
  const unlinked: { name: string; link: string }[] = [];
  for (let i = 0; i < names.length; i++) {
    let link: string | null = null;
    try {
      link = await save(i);
    } catch (e) {
      ctx.fail(`${names[i]} was not attached: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (closed.has(view) || !view.state.field(pendingAttachments, false)) {
      if (link) unlinked.push({ name: names[i], link });
      continue;
    }
    const at = markerAt(view.state, ids[i]);
    if (at === null || !link) {
      view.dispatch({ effects: endPending.of({ id: ids[i], batch }) });
      if (link) ctx.fail(`${names[i]} was attached, but the place for its link was removed or undone, so the page has no link to it.`);
      continue;
    }
    const insert = (linked ? "\n" : lead) + link;
    linked = true;
    view.dispatch({ changes: { from: at, insert }, effects: endPending.of({ id: ids[i], batch, to: at + insert.length }), userEvent: "input.paste" });
  }
  // Every link a closed page missed goes on the clipboard at once (Codex re-review of 87a0a1f).
  if (unlinked.length) lost(ctx, unlinked);
}

/** Say that attachments were saved but not linked because the page closed, and put their links on the clipboard. */
export function lost(ctx: RichContext, items: { name: string; link: string }[]) {
  const names = items.map((it) => it.name).join(", ");
  const links = items.map((it) => it.link).join("\n");
  const one = items.length === 1;
  const say = (copied: boolean) => ctx.fail(`${names} ${one ? "was" : "were"} attached, but the page was closed before ${one ? "it" : "they"} could be linked.${copied ? ` ${one ? "Its link is" : "Their links are"} on the clipboard.` : ` ${one ? "Its link" : "Their links"}: ${links}`}`);
  try {
    navigator.clipboard.writeText(links).then(() => say(true), () => say(false));
  } catch {
    say(false);
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
