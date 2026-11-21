// The inline half of the rich page editor (NS-3A), over the visible part of the page: ==highlights==, %%comments%%,
// `$math$`, pictures inside a line, `![[picture.png]]`, footnote references, and the targets of links for Ctrl+click.
// Marks stay visible on the lines that hold the cursor, as in the plain live preview. Ranges the block field replaced
// are left alone.
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { replacedBlocks } from "./blocks";
import { richContext, richRefresh } from "./context";
import { footnoteDefs, footnoteRefs, isPicture, parseEmbed } from "./parse";
import { FootnoteWidget, MathWidget, PictureWidget } from "./widgets";

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "CodeMark", "InlineMath", "BlockMath", "Comment"]);
const hide = Decoration.replace({});

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  return lines;
}

// Footnote definitions are read from the whole page once per version of it.
const defsCache = new WeakMap<Text, Map<string, string>>();
function definitions(doc: Text): Map<string, string> {
  let defs = defsCache.get(doc);
  if (!defs) { defs = footnoteDefs(doc.iterLines()); defsCache.set(doc, defs); }
  return defs;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const ctx = state.facet(richContext);
  const active = activeLines(state);
  const touches = (from: number, to: number) => {
    for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };
  const blocks = replacedBlocks(state);
  const replaced = (from: number, to: number) => {
    let hit = false;
    blocks.between(from, to, (_f, _t, d) => { if (d.spec.block) { hit = true; return false; } });
    return hit;
  };
  const tree = syntaxTree(state);
  const out: Range<Decoration>[] = [];
  const href = (from: number, to: number, url: string) =>
    out.push(Decoration.mark({ attributes: { "data-href": url, title: `${url}\nCtrl+click to open` } }).range(from, to));
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        if (replaced(node.from, node.to)) return false;
        switch (node.name) {
          case "Highlight": {
            const marks = node.node.getChildren("HighlightMark");
            if (marks.length !== 2) return;
            if (touches(node.from, node.to)) { out.push(Decoration.mark({ class: "cm-highlight" }).range(node.from, node.to)); return; }
            out.push(hide.range(marks[0].from, marks[0].to), Decoration.mark({ class: "cm-highlight" }).range(marks[0].to, marks[1].from), hide.range(marks[1].from, marks[1].to));
            return;
          }
          case "Comment":
            out.push(Decoration.mark({ class: "cm-comment" }).range(node.from, node.to));
            return false;
          case "InlineMath": {
            if (touches(node.from, node.to)) { out.push(Decoration.mark({ class: "cm-math-source" }).range(node.from, node.to)); return false; }
            const marks = node.node.getChildren("InlineMathMark");
            if (marks.length === 2) out.push(Decoration.replace({ widget: new MathWidget(state.sliceDoc(marks[0].to, marks[1].from), false) }).range(node.from, node.to));
            return false;
          }
          case "Image": {
            if (!ctx || touches(node.from, node.to)) return false;
            const embed = parseEmbed(state.sliceDoc(node.from, node.to));
            if (embed?.kind === "picture") {
              out.push(Decoration.replace({ widget: new PictureWidget(state.sliceDoc(node.from, node.to), ctx.pictureUrl(embed.src, embed.wiki), embed.alt, embed.width, false) }).range(node.from, node.to));
            }
            return false;
          }
          case "Link": {
            const url = node.node.getChild("URL");
            if (url) href(node.from, node.to, state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ""));
            return;
          }
          case "URL":
            if (node.node.parent?.name !== "Link" && node.node.parent?.name !== "Image") href(node.from, node.to, state.sliceDoc(node.from, node.to));
            return;
          case "Autolink": {
            const url = node.node.getChild("URL");
            if (url) href(node.from, node.to, state.sliceDoc(url.from, url.to));
            return false;
          }
        }
        if (CODE.has(node.name)) return false;
      },
    });
    // Text patterns Markdown has no syntax for: `![[picture.png]]` and footnotes.
    const text = state.sliceDoc(from, to);
    const inCode = (pos: number) => CODE.has(tree.resolveInner(pos, 1).name);
    if (ctx) {
      for (const m of text.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
        const a = from + m.index!, b = a + m[0].length;
        const embed = parseEmbed(m[0]);
        if (embed?.kind !== "picture" || !isPicture(embed.src) || inCode(a) || replaced(a, b) || touches(a, b)) continue;
        out.push(Decoration.replace({ widget: new PictureWidget(m[0], ctx.pictureUrl(embed.src, embed.wiki), embed.alt, embed.width, false) }).range(a, b));
      }
    }
    if (text.includes("[^")) {
      const defs = definitions(state.doc);
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        if (/^\[\^[^\]\s]+\]:/.test(line.text)) {
          out.push(Decoration.line({ class: "cm-footnote-def" }).range(line.from));
        } else if (!touches(line.from, line.to)) {
          for (const ref of footnoteRefs(line.text)) {
            const a = line.from + ref.from, b = line.from + ref.to;
            if (a < from || b > to || inCode(a) || replaced(a, b)) continue;
            out.push(Decoration.replace({ widget: new FootnoteWidget(ref.id, defs.get(ref.id)) }).range(a, b));
          }
        }
        pos = line.to + 1;
      }
    }
  }
  return Decoration.set(out, true);
}

export const richInline = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)
      || u.transactions.some((tr) => tr.effects.some((e) => e.is(richRefresh)))) this.decorations = build(u.view);
  }
}, { decorations: (v) => v.decorations });

/** Ctrl+click on a link opens it (Ctrl+Shift+click: in a split, for pages). */
export const richLinks = EditorView.domEventHandlers({
  mousedown: (e, view) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-href]");
    const ctx = view.state.facet(richContext);
    if (!link || !ctx || !(e.ctrlKey || e.metaKey)) return false;
    e.preventDefault();
    ctx.openHref(link.dataset.href!, e.shiftKey);
    return true;
  },
});
