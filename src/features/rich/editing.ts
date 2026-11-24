// Editing helpers of the .hmdoc editor (from NS-3B): typing `[[...]]`, `![[...]]` and `$...$` makes links, embeds and math;
// the slash menu's state; moving blocks; markers where pictures being saved will be linked; and Markdown pasted from
// the clipboard. Nothing here writes to the document except in answer to the user.
import { Extension, InputRule, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { lost } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { markdownNodes } from "./fromMarkdown";

/** Typing that becomes an atom: `[[Page]]`, `![[Page]]`, and `$x$` by Obsidian's rules (no space inside the marks). */
export const RichInputRules = Extension.create({
  name: "richInputRules",
  addInputRules() {
    const atom = (find: RegExp, make: (m: RegExpMatchArray, schema: Schema) => PMNode) => new InputRule({
      find,
      handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, make(match, state.schema));
      },
    });
    return [
      atom(/!\[\[([^[\]\n]+)\]\]$/, (m, s) => s.nodes.embed.create({ value: m[1] })),
      atom(/(?<!!)\[\[([^[\]\n]+)\]\]$/, (m, s) => s.nodes.wikiLink.create({ value: m[1] })),
      atom(/(?<=^|[\s(])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$$/, (m, s) => s.nodes.mathInline.create({ value: m[1], dollars: 1 })),
    ];
  },
});

/** The block at the top of the page that holds the selection, and where it starts. */
function topBlock(state: EditorState): { index: number; start: number; node: PMNode } | null {
  const index = state.selection.$from.index(0);
  if (index >= state.doc.childCount) return null;
  let start = 0;
  for (let i = 0; i < index; i++) start += state.doc.child(i).nodeSize;
  return { index, start, node: state.doc.child(index) };
}

/** Move the top-level block at `from` to sit before the block now at `to` (or at the end). The block keeps its
 *  identity, so an untouched block keeps its source wherever it goes. */
export function moveTopBlock(view: EditorView, from: number, to: number): boolean {
  const { doc } = view.state;
  if (from < 0 || from >= doc.childCount || to < 0 || to > doc.childCount || to === from || to === from + 1) return false;
  let start = 0;
  for (let i = 0; i < from; i++) start += doc.child(i).nodeSize;
  const node = doc.child(from);
  let target = 0;
  for (let i = 0; i < to; i++) target += doc.child(i).nodeSize;
  const offset = view.state.selection.from - start;
  const tr = view.state.tr.delete(start, start + node.nodeSize);
  const at = to > from ? target - node.nodeSize : target;
  tr.insert(at, node);
  const inside = offset >= 0 && offset <= node.nodeSize;
  tr.setSelection(inside ? Selection.near(tr.doc.resolve(Math.min(at + Math.max(offset, 1), tr.doc.content.size))) : NodeSelection.create(tr.doc, at));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Alt+Shift+Up and Down move the block holding the selection; Ctrl+S saves. */
export function richKeys(save: () => void) {
  return Extension.create({
    name: "richKeys",
    addKeyboardShortcuts() {
      const move = (dir: -1 | 1) => () => {
        const top = topBlock(this.editor.state);
        if (!top || !this.editor.isEditable) return false;
        return moveTopBlock(this.editor.view, top.index, dir < 0 ? top.index - 1 : top.index + 2);
      };
      return {
        "Mod-s": () => { save(); return true; },
        "Alt-Shift-ArrowUp": move(-1),
        "Alt-Shift-ArrowDown": move(1),
      };
    },
  });
}

/** `/word` typed at the start of an otherwise empty paragraph. */
export interface SlashState { from: number; to: number; query: string }
type SlashPluginState = { open: SlashState | null; closedAt: number | null };
export const slashKey = new PluginKey<SlashPluginState>("richSlash");

function slashAt(state: EditorState): SlashState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = /^\/([\w ]{0,24})$/.exec(text);
  if (!m || $from.parentOffset !== $from.parent.content.size) return null;
  return { from: $from.start(), to: $from.pos, query: m[1] };
}

/** The slash menu's state, and its keys while it is open: `keys` is set by the menu that is showing. */
export function slashPlugin(keys: { current: ((key: string) => boolean) | null }) {
  return Extension.create({
    name: "richSlash",
    addProseMirrorPlugins() {
      return [new Plugin<SlashPluginState>({
        key: slashKey,
        state: {
          init: (): SlashPluginState => ({ open: null, closedAt: null }),
          apply(tr, prev, _old, state): SlashPluginState {
            const closeAt = tr.getMeta(slashKey) as number | undefined;
            const at = slashAt(state);
            const closedAt = closeAt ?? (at && prev.closedAt === at.from ? prev.closedAt : null);
            return { open: at && closedAt !== at.from ? at : null, closedAt };
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (!slashKey.getState(view.state)?.open) return false;
            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(slashKey, slashKey.getState(view.state)!.open!.from));
              return true;
            }
            if (["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key) && keys.current?.(event.key)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      })];
    },
  });
}

/** Where pictures being saved will be linked: widgets that follow edits and never enter the document or its history. */
const pendingKey = new PluginKey<DecorationSet>("richPending");
type PendingMeta = { add?: { id: number; pos: number; name: string }[]; remove?: number[] };

/** Pictures whose marker Undo took away: their attachments get no link, and no message. */
const cancelled = new Set<number>();

/** Undo while pictures are being saved cancels their links and undoes nothing else, as in Live (Codex review of
 *  2392f6b, R1-14). The markers never enter the history, so the history's own Undo would skip them. */
function cancelPendingUndo(view: EditorView): boolean {
  const ids = (pendingKey.getState(view.state)?.find() ?? []).map((d) => (d.spec as { id: number }).id);
  if (!ids.length) return false;
  for (const id of ids) cancelled.add(id);
  view.dispatch(view.state.tr.setMeta(pendingKey, { remove: ids } satisfies PendingMeta).setMeta("addToHistory", false));
  return true;
}

export const PendingPictures = Extension.create({
  name: "richPending",
  priority: 1000,
  addKeyboardShortcuts() {
    return { "Mod-z": () => cancelPendingUndo(this.editor.view) };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: pendingKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          let next = set.map(tr.mapping, tr.doc);
          const meta = tr.getMeta(pendingKey) as PendingMeta | undefined;
          if (meta?.add) {
            next = next.add(tr.doc, meta.add.map((p) => Decoration.widget(p.pos, () => {
              const mark = document.createElement("span");
              mark.className = "rich-attaching";
              mark.textContent = `Saving ${p.name}…`;
              return mark;
            }, { id: p.id, side: -1 })));
          }
          if (meta?.remove) next = next.remove(next.find(undefined, undefined, (spec) => meta.remove!.includes(spec.id)));
          return next;
        },
      },
      props: {
        decorations: (state) => pendingKey.getState(state),
        handleDOMEvents: {
          beforeinput: (view, e) => {
            if (e.inputType !== "historyUndo" || !cancelPendingUndo(view)) return false;
            e.preventDefault();
            return true;
          },
        },
      },
    })];
  },
});

function pendingPos(state: EditorState, id: number): number | null {
  const found = pendingKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id) ?? [];
  return found.length ? found[0].from : null;
}

let counter = 0;

/** Mark `pos` for each picture, save each, and put its link where its marker is then. `save` resolves to the
 *  Markdown that links it. Links a closed editor missed go to the clipboard, as in Live. */
export async function attachPictures(editor: Editor, ctx: RichContext, pos: number, names: string[], save: (i: number) => Promise<string>): Promise<void> {
  if (!names.length || !editor.isEditable) return;
  const ids = names.map(() => ++counter);
  editor.view.dispatch(editor.state.tr.setMeta(pendingKey, { add: names.map((name, i) => ({ id: ids[i], pos, name: name.replace(/[[\]]/g, "") })) } satisfies PendingMeta).setMeta("addToHistory", false));
  const unlinked: { name: string; link: string }[] = [];
  for (let i = 0; i < names.length; i++) {
    let link: string | null = null;
    try {
      link = await save(i);
    } catch (e) {
      ctx.fail(`${names[i]} was not attached: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Undo cancelled this one: no link, here or on the clipboard (Codex review of b0afec0, R2-8).
    if (cancelled.delete(ids[i])) continue;
    if (editor.isDestroyed) {
      if (link) unlinked.push({ name: names[i], link });
      continue;
    }
    const at = pendingPos(editor.state, ids[i]);
    const tr = editor.state.tr.setMeta(pendingKey, { remove: [ids[i]] } satisfies PendingMeta);
    if (at === null || !link) {
      editor.view.dispatch(tr.setMeta("addToHistory", false));
      if (link) ctx.fail(`${names[i]} was attached, but the place for its link was removed, so the page has no link to it.`);
      continue;
    }
    const content = inlineOf(editor.schema, link);
    editor.view.dispatch(tr.insert(at, content));
  }
  if (unlinked.length) lost(ctx, unlinked);
}

/** Markdown as inline content when it is one paragraph, else as blocks. */
function inlineOf(schema: Schema, text: string): Fragment {
  const nodes = markdownNodes(schema, text);
  if (nodes.length === 1 && nodes[0].type.name === "paragraph") return nodes[0].content;
  return Fragment.from(nodes);
}

const MARKDOWNISH = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||\$\$)|\*\*|__|\[[^\]]*\]\(|\[\[|==|`|\$/;

/** Plain text pasted into the editor: Markdown becomes blocks and marks; other text stays text. */
export function pastedSlice(schema: Schema, text: string): Slice | null {
  if (!MARKDOWNISH.test(text)) return null;
  const nodes = markdownNodes(schema, text.replace(/\r\n?/g, "\n"));
  if (!nodes.length) return null;
  if (nodes.length === 1 && nodes[0].type.name === "paragraph") return new Slice(nodes[0].content, 0, 0);
  return new Slice(Fragment.from(nodes), 0, 0);
}
