import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { livePreview } from "./livePreview";

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "ui-monospace, Consolas, monospace", fontSize: "0.92em" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--fg)", padding: "8px 0 120px" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-tooltip": { background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-soft)", color: "var(--fg)" },
  ".cm-panels": { background: "var(--bg-alt)", color: "var(--fg)" },
});

/** `[[` completes note titles; picking one closes the link. */
function wikilinkSource(titles: () => string[]) {
  return (ctx: CompletionContext) => {
    const before = ctx.matchBefore(/\[\[[^\]|#\n]*$/);
    if (!before) return null;
    const from = before.from + 2;
    const options: Completion[] = titles().map((title) => ({
      label: title,
      type: "text",
      apply: (view, _c, start, end) => {
        const closed = view.state.sliceDoc(end, end + 2) === "]]";
        view.dispatch({ changes: { from: start, to: closed ? end + 2 : end, insert: `${title}]]` }, selection: { anchor: start + title.length + 2 } });
      },
    }));
    return { from, options, validFor: /^[^\]|#\n]*$/ };
  };
}

export interface EditorProps {
  doc: string;
  docVersion: number;               // bump to replace the document (after save, merge or an outside change)
  live: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  titles: () => string[];
  onOpenLink: (target: string, split: boolean) => void;
  reveal?: { line: number; at: number } | null;
}

export function MarkdownEditor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const preview = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.doc,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(style),
          highlightSelectionMatches(),
          autocompletion({ override: [wikilinkSource(() => latest.current.titles())], icons: false }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { latest.current.onSave(); return true; } },
            ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
          ]),
          preview.current.of(props.live ? livePreview : []),
          placeholder("Write the Executive Summary first…"),
          theme,
          EditorView.updateListener.of((u) => { if (u.docChanged) latest.current.onChange(u.state.doc.toString()); }),
          EditorView.domEventHandlers({
            mousedown: (e) => {
              const el = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
              if (!el || !(e.ctrlKey || e.metaKey)) return false;
              e.preventDefault();
              latest.current.onOpenLink(el.dataset.wikilink!, e.shiftKey);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // The editor is created once; later prop changes flow through the effects below.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: preview.current.reconfigure(props.live ? livePreview : []) });
  }, [props.live]);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === props.doc) return;
    const head = Math.min(v.state.selection.main.head, props.doc.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.doc }, selection: { anchor: head } });
  }, [props.docVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (!v || !props.reveal) return;
    const line = v.state.doc.line(Math.min(props.reveal.line + 1, v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }) });
    v.focus();
  }, [props.reveal]);

  return <div className="md-editor" ref={host} />;
}
