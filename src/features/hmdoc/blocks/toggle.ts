// A toggle (NS-3C): a summary line and a body that is open or closed. Whether it is open is part of the page, so
// opening and closing it is an edit, as it is for a heading's fold in other editors that save the state.
import { Node, type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary block+",
  defining: true,
  addAttributes: () => ({ open: { default: true, rendered: false } }),
  parseHTML: () => [{ tag: "div[data-toggle]", getAttrs: (el) => ({ open: (el as HTMLElement).dataset.toggle !== "closed" }) }],
  renderHTML: ({ node }) => ["div", { "data-toggle": node.attrs.open ? "open" : "closed", class: "hm-toggle" }, 0],
  addNodeView() {
    return ({ node: first, getPos, editor }) => {
      let node = first;
      const dom = document.createElement("div");
      const caret = document.createElement("button");
      const content = document.createElement("div");
      caret.type = "button";
      caret.contentEditable = "false";
      caret.className = "hm-toggle-caret";
      content.className = "hm-toggle-content";
      dom.append(caret, content);
      const draw = () => {
        const open = !!node.attrs.open;
        dom.className = `hm-toggle ${open ? "open" : "closed"}`;
        caret.textContent = open ? "▾" : "▸";
        caret.title = open ? "Close this toggle" : "Open this toggle";
        caret.setAttribute("aria-expanded", String(open));
        caret.setAttribute("aria-label", caret.title);
      };
      draw();
      caret.addEventListener("mousedown", (e) => e.preventDefault());
      caret.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined || !editor.isEditable) return;
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: !node.attrs.open });
        // A cursor in a body about to be hidden goes to the end of the summary.
        const { from } = editor.state.selection;
        if (node.attrs.open && from > pos + 1 + node.child(0).nodeSize) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + node.child(0).nodeSize)));
        editor.view.dispatch(tr);
      });
      return {
        dom,
        contentDOM: content,
        update(next) {
          if (next.type !== node.type) return false;
          node = next;
          draw();
          return true;
        },
        stopEvent: (e) => caret.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => !content.contains((m as MutationRecord).target),
      };
    };
  },
});

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "div[data-toggle-summary]" }],
  renderHTML: () => ["div", { "data-toggle-summary": "", class: "hm-toggle-summary" }, 0],
});

/** A toggle in place of the empty paragraph holding the cursor, else after the block that holds it. */
export function insertToggle(editor: Editor): boolean {
  const { schema } = editor.state;
  const node = schema.nodes.toggle.create({ open: true }, [schema.nodes.toggleSummary.create(), schema.nodes.paragraph.create()]);
  const { $from } = editor.state.selection;
  const empty = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
  const tr = editor.state.tr;
  const pos = empty ? $from.before() : $from.after();
  if (empty) tr.replaceWith(pos, $from.after(), node);
  else tr.insert(pos, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}
