import { language } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { editorExtensions, type CodeEditorProps } from "./CodeEditor";

const props = (over: Partial<CodeEditorProps> = {}): CodeEditorProps => ({
  doc: "# Title", docVersion: 0, language: "markdown", live: false, readOnly: false, lineNumbers: false,
  onChange: () => {}, onSave: () => {}, titles: () => [], onOpenLink: () => {}, ...over,
});
const stateOf = (p: CodeEditorProps) => {
  const sw = { preview: new Compartment(), readOnly: new Compartment(), gutter: new Compartment() };
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
