// Putting embeds into the page and changing them (NS-3D). Every attribute set is checked by the rules first, so the page
// never holds an embed that would make the file reopen read-only.
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { nodeProblem } from "../rules";
import type { Drawing } from "./drawing";
import type { EmbedType } from "./embeds";

/** Attributes of `type` with the defaults filled in, as the node would hold them. */
function complete(editor: Editor, type: EmbedType, attrs: Record<string, unknown>): Record<string, unknown> {
  const nodeType = editor.state.schema.nodes[type];
  return nodeType.create(attrs).attrs;
}

/** A new embed in place of the empty paragraph holding the cursor, else after the block that holds it, and selected.
 *  False when the attributes are not ones the rules take. */
export function insertEmbed(editor: Editor, type: EmbedType, attrs: Record<string, unknown>): boolean {
  const full = complete(editor, type, attrs);
  if (nodeProblem(type, full)) return false;
  const node = editor.state.schema.nodes[type].create(full);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  const pos = empty ? $from.before() : $from.after();
  if (empty) tr.replaceWith(pos, $from.after(), node);
  else tr.insert(pos, node);
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

/** New attributes for the embed at `pos`, which must be of this type. */
export function updateEmbed(editor: Editor, pos: number, type: EmbedType, attrs: Record<string, unknown>): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== type) return false;
  const full = complete(editor, type, { ...node.attrs, ...attrs });
  if (nodeProblem(type, full)) return false;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, full));
  return true;
}

/** The drawing blocks of the page that hold this scene, with their positions. */
function blocksOf(doc: PMNode, scene: string): number[] {
  const found: number[] = [];
  doc.descendants((n, pos) => { if (n.type.name === "excalidraw" && n.attrs.scene === scene) found.push(pos); return true; });
  return found;
}

/** Whether any drawing block of the page shows this preview. */
export function usesPreview(doc: PMNode, preview: string): boolean {
  let used = false;
  doc.descendants((n) => { if (n.type.name === "excalidraw" && n.attrs.preview === preview) used = true; return !used; });
  return used;
}

/** The page points at a saved drawing. With `replaces` (the scene of the block that was edited), every block of the page
 *  that holds that scene takes the new files, so a copy of the block does not keep a preview that is gone; with none, a new
 *  block is inserted. False when no block of the page held `replaces` (it was deleted while the drawing was open). */
export function applyDrawing(editor: Editor, next: Drawing, replaces: string | null): boolean {
  if (replaces === null) return insertEmbed(editor, "excalidraw", { ...next, title: "Drawing" });
  const at = blocksOf(editor.state.doc, replaces);
  if (!at.length) return false;
  const tr = editor.state.tr;
  for (const pos of at) {
    const node = tr.doc.nodeAt(pos)!;
    const attrs = complete(editor, "excalidraw", { ...node.attrs, ...next });
    if (nodeProblem("excalidraw", attrs)) return false;
    tr.setNodeMarkup(pos, undefined, attrs);
  }
  editor.view.dispatch(tr);
  return true;
}
