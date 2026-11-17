import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { getChunks, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../lib/theme";
import { loadLanguage } from "./language";

const code = HighlightStyle.define([
  { tag: [t.keyword, t.modifier], color: "var(--accent)", fontWeight: "600" },
  { tag: [t.string, t.regexp], color: "var(--syntax-string)" },
  { tag: [t.comment, t.meta], color: "var(--muted)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--teal)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName, t.tagName, t.attributeName], color: "var(--syntax-fn)" },
]);

const look = {
  "&": { backgroundColor: "var(--bg-code)", color: "var(--fg)", fontSize: ".93rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: ".5rem 0" },
  ".cm-gutters": { backgroundColor: "var(--bg-code)", color: "var(--muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 .8rem 0 1rem", minWidth: "3.4rem" },
  ".cm-line": { padding: "0 1rem 0 2.2rem", position: "relative" },
  "&.cm-merge-b .cm-changedLine": { backgroundColor: "var(--diff-add)" },
  "&.cm-merge-b .cm-changedLine::before": { content: '"+"', position: "absolute", left: ".7rem", color: "var(--success)" },
  ".cm-deletedChunk": { backgroundColor: "var(--diff-del)", paddingLeft: "0" },
  ".cm-deletedChunk .cm-deletedLine": { padding: "0 1rem 0 2.2rem", position: "relative" },
  ".cm-deletedChunk .cm-deletedLine::before": { content: '"\\2212"', position: "absolute", left: ".7rem", color: "var(--error)" },
  ".cm-collapsedLines": { background: "var(--bg-alt)", color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: ".86rem" },
};
// CodeMirror's own defaults (selection, merge marks) follow the light or dark base.
const darkTheme = EditorView.theme(look, { dark: true });
const lightTheme = EditorView.theme(look);

/** One file's changes as a read-only unified diff: line numbers, added and removed lines on the diff colours. */
export function CodeDiff({ path, base, head }: { path: string; base: string; head: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [language, setLanguage] = useState<{ path: string; support: LanguageSupport | null } | null>(null);
  const [same, setSame] = useState(false);
  const theme = useTheme() === "emerald-light" ? lightTheme : darkTheme;

  useEffect(() => {
    let gone = false;
    loadLanguage(path).then((support) => { if (!gone) setLanguage({ path, support }); });
    return () => { gone = true; };
  }, [path]);

  useEffect(() => {
    // The deleted lines' colours are built once, so the editor waits for the language.
    if (language?.path !== path || !host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: head,
        extensions: [
          lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), language.support ?? [], syntaxHighlighting(code), theme,
          unifiedMergeView({ original: base, mergeControls: false, gutter: false, highlightChanges: false, collapseUnchanged: { margin: 3, minSize: 8 } }),
        ],
      }),
    });
    setSame(getChunks(view.state)?.chunks.length === 0);
    return () => view.destroy();
  }, [path, base, head, language, theme]);

  return (
    <>
      {language?.path !== path && <p className="muted">Loading diff…</p>}
      {same && <p className="muted small">No visible changes: only line endings differ.</p>}
      <div className="review-diff" ref={host} role="group" aria-label={`Changes to ${path}`} />
    </>
  );
}
