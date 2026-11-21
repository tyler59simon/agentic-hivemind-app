import { language } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { editorExtensions, followSpec, isOwnEdit, type CodeEditorProps } from "./CodeEditor";

const props = (over: Partial<CodeEditorProps> = {}): CodeEditorProps => ({
  doc: "# Title", docVersion: 0, language: "markdown", live: false, readOnly: false, lineNumbers: false,
  onChange: () => {}, onSave: () => {}, titles: () => [], onOpenLink: () => {}, ...over,
});
const stateOf = (p: CodeEditorProps) => {
  const sw = { preview: new Compartment(), readOnly: new Compartment(), gutter: new Compartment(), rich: new Compartment() };
  return EditorState.create({ doc: p.doc, extensions: editorExtensions(p, { current: p }, sw) });
};
const wraps = (s: EditorState) => s.facet(EditorView.contentAttributes).some((a) => typeof a === "object" && String(a.class ?? "").includes("cm-lineWrapping"));

describe("editor configuration", () => {
  it("a note gets the Markdown editor it always had: wrapped, editable, Markdown language", () => {
    const s = stateOf(props());
    expect(s.facet(language)?.name).toBe("markdown");
    expect(s.readOnly).toBe(false);
    expect(wraps(s)).toBe(true);
  });

  it("a text file gets no Markdown and no wrapping, and can be read-only", () => {
    const s = stateOf(props({ language: "text", lineNumbers: true, readOnly: true }));
    expect(s.facet(language)).toBeNull();
    expect(wraps(s)).toBe(false);
    expect(s.readOnly).toBe(true);
  });
});

describe("two panes of one page", () => {
  it("the second pane takes the first pane's edits without reporting them back or moving its own cursor", () => {
    let paneB = EditorState.create({ doc: "alpha\nbeta\ngamma\n", selection: { anchor: 14 } });
    // Pane A typed " one" after "alpha" (the store now holds its text).
    const spec = followSpec(paneB.doc.toString(), "alpha one\nbeta\ngamma\n")!;
    expect(spec.changes).toEqual({ from: 5, to: 5, insert: " one" });
    const tr = paneB.update(spec);
    expect(isOwnEdit(tr)).toBe(false);
    paneB = tr.state;
    expect(paneB.doc.toString()).toBe("alpha one\nbeta\ngamma\n");
    expect(paneB.selection.main.head).toBe(18);
    // Pane B's own typing is reported, so it reaches the store with pane A's edit included.
    const typed = paneB.update({ changes: { from: 18, insert: "!" } });
    expect(isOwnEdit(typed)).toBe(true);
    expect(typed.state.doc.toString()).toBe("alpha one\nbeta\ngam!ma\n");
    expect(followSpec("same", "same")).toBeNull();
  });
});
