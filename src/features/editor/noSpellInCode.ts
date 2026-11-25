// Spell checking for a Markdown editor skips code (DESK-8): the lines of a fence or an indented code block, inline code,
// URLs and the target of a [[wikilink]] get spellcheck="false", which the browser reads on the nearest element that has it.
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { wikilinks } from "../../lib/note";
import { CODE } from "./livePreview";

const off = { spellcheck: "false" };
const lineOff = Decoration.line({ attributes: off });
const markOff = Decoration.mark({ attributes: off });

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          for (let pos = node.from; pos <= node.to;) {
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
    // [[links]] are not Markdown syntax (see livePreview). Only the page name is left alone: a #heading and an alias are prose.
    const text = state.sliceDoc(from, to);
    for (const link of wikilinks(text)) {
      const a = from + link.from;
      if (CODE.has(tree.resolveInner(a, 1).name)) continue;
      const inner = text.slice(link.from + 2, link.to - 2);
      const end = inner.search(/[#|]/);
      deco.push(markOff.range(a + 2, a + 2 + (end < 0 ? inner.length : end)));
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
