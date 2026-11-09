// Obsidian-style live preview for CodeMirror 6: Markdown markup is hidden except on the lines being edited,
// task boxes become clickable checkboxes, rules become lines, and [[links]] show as links (Ctrl+click opens).
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { wikilinks } from "../../lib/note";

const hide = Decoration.replace({});

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked && other.pos === this.pos; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const el = document.createElement("span"); el.className = "cm-bullet"; el.textContent = "•"; return el; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const el = document.createElement("span"); el.className = "cm-rule"; return el; }
}

/** Line numbers that hold a cursor or selection; their markup stays visible for editing. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) lines.add(l);
  }
  return lines;
}

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText"]);

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const touches = (from: number, to: number) => {
    for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) if (active.has(l)) return true;
    return false;
  };
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          deco.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
        } else if (name === "HeaderMark") {
          if (!touches(node.from, node.to)) deco.push(hide.range(node.from, Math.min(node.to + 1, state.doc.lineAt(node.from).to)));
        } else if (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          const parent = node.node.parent;
          if (parent && parent.name !== "FencedCode" && !touches(parent.from, parent.to)) deco.push(hide.range(node.from, node.to));
        } else if (name === "Link" && !touches(node.from, node.to)) {
          // [label](url "title") shows just the label: hide "[" and everything from "]" on.
          const marks = node.node.getChildren("LinkMark");
          if (marks.length >= 2 && marks[0].to < marks[1].from) {
            deco.push(hide.range(marks[0].from, marks[0].to));
            deco.push(Decoration.mark({ class: "cm-link" }).range(marks[0].to, marks[1].from));
            deco.push(hide.range(marks[1].from, node.to));
          }
        } else if (name === "TaskMarker") {
          if (!touches(node.from, node.to)) {
            const checked = state.sliceDoc(node.from + 1, node.from + 2) !== " ";
            deco.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
          }
        } else if (name === "ListMark") {
          const task = node.node.parent?.getChild("Task");
          if (touches(node.from, node.to)) { /* keep the marker editable */ }
          else if (task) deco.push(hide.range(node.from, Math.min(node.to + 1, task.from)));
          else if (node.node.parent?.parent?.name === "BulletList") {
            deco.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          }
        } else if (name === "HorizontalRule") {
          if (!touches(node.from, node.to)) deco.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
        } else if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            deco.push(Decoration.line({ class: "cm-quote" }).range(line.from));
            pos = line.to + 1;
          }
        }
      },
    });
    // [[links]] are not Markdown syntax, so they are found by the same pattern LM uses.
    const text = state.sliceDoc(from, to);
    for (const link of wikilinks(text)) {
      const a = from + link.from, b = from + link.to;
      if (CODE.has(tree.resolveInner(a, 1).name)) continue;
      if (touches(a, b)) { deco.push(Decoration.mark({ class: "cm-wikilink-source" }).range(a, b)); continue; }
      const inner = text.slice(link.from + 2, link.to - 2);
      const pipe = inner.indexOf("|");
      const shown = pipe >= 0 ? a + 2 + pipe + 1 : a + 2;
      if (shown >= b - 2) continue;
      deco.push(hide.range(a, shown));
      deco.push(Decoration.mark({
        class: "cm-wikilink", attributes: { "data-wikilink": link.target, title: "Ctrl+click to open" },
      }).range(shown, b - 2));
      deco.push(hide.range(b - 2, b));
    }
  }
  return Decoration.set(deco, true);
}

export const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
  }
}, { decorations: (v) => v.decorations });
