// Spell checking for a Markdown editor skips code (DESK-8): the lines of a fence or an indented code block, inline code,
// URLs and the target of a [[wikilink]] get spellcheck="false", which the browser reads on the nearest element that has it.
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { CODE } from "./livePreview";

const off = { spellcheck: "false" };
const lineOff = Decoration.line({ attributes: off });
const markOff = Decoration.mark({ attributes: off });

/** The page names of the [[wikilinks]] on one line, as [from, to) offsets into its text. A link is `[[` up to the next `]]`
 *  on the line; a line with a `[[` and no `]]` after it is done. Only the page name is left alone: a #heading and an alias
 *  are prose. One pass, so a line of nothing but brackets costs no more than its length. */
function pageNames(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (let at = text.indexOf("[["); at >= 0; at = text.indexOf("[[", at)) {
    const close = text.indexOf("]]", at + 2);
    if (close < 0) break;
    const inner = text.slice(at + 2, close);
    const end = inner.search(/[#|]/);
    const name = end < 0 ? inner.length : end;
    if (inner.trim()) found.push([at + 2, at + 2 + name]);
    at = close + 2;
  }
  return found;
}

/** Whether a position is in code: it or any node around it is a code node. */
function inCode(tree: ReturnType<typeof syntaxTree>, pos: number): boolean {
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1); node; node = node.parent) if (CODE.has(node.name)) return true;
  return false;
}

/** The view as the plugin reads it, so a test can give a stub. */
export type Seen = Pick<EditorView, "state" | "visibleRanges">;

export function build(view: Seen): DecorationSet {
  const { state } = view;
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    const blocks: [number, number][] = [];
    tree.iterate({
      from, to,
      enter: (node) => {
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          blocks.push([node.from, node.to]);
          // Only the visible lines: a long fence would otherwise be walked whole on every keystroke.
          for (let pos = Math.max(node.from, from), end = Math.min(node.to, to); pos <= end;) {
            const line = state.doc.lineAt(pos);
            deco.push(lineOff.range(line.from));
            pos = line.to + 1;
          }
          return false;
        }
        if (node.name === "InlineCode" || node.name === "URL") {
          deco.push(markOff.range(node.from, node.to));
          return false;
        }
      },
    });
    // [[links]] are not Markdown syntax (see livePreview). Whole lines are read, since a link may end past the visible
    // range; its mark is cut to what is visible. Lines of a fence or code block are off already.
    let next = 0;
    for (let n = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; n <= last; n++) {
      const line = state.doc.line(n);
      while (next < blocks.length && blocks[next][1] < line.from) next++;
      if (next < blocks.length && blocks[next][0] <= line.from) continue;
      for (const [a, b] of pageNames(line.text)) {
        const start = Math.max(line.from + a, from), end = Math.min(line.from + b, to);
        if (start < end && !inCode(tree, line.from + a)) deco.push(markOff.range(start, end));
      }
    }
  }
  return Decoration.set(deco, true);
}

export const noSpellInCode = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
  }
}, { decorations: (v) => v.decorations });
