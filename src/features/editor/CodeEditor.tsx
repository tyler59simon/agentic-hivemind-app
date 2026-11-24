import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { registerDropTarget } from "../notes/drops";
import { livePreview } from "./livePreview";
import { documentIsDark, onDocumentLook } from "../../lib/paper";
import { linkClick } from "../../lib/platform";
import { dropPictures, RICH_LIMIT, richDark, richEditing, richLanguage, richLook, richPreview, richRefresh, slashSource, type RichContext } from "./rich";
import { richContext as richContextFacet } from "./rich/context";
import { Toolbar } from "./toolbar";
import { powerExtensions } from "../power/extensions";
import { isReplaying, replayDone } from "../power/macros";
import { describe, support } from "../power/language";
import { PowerBar } from "../power/PowerBar";
import { setEditor } from "../power/registry";

export const editorHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.92em" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.quote], color: "var(--muted)" },
  // Code inside a page's fences (NS-3A), colored as in the diff view. Without these the nested languages parse but
  // draw nothing.
  { tag: [t.keyword, t.modifier], color: "var(--accent)", fontWeight: "600" },
  { tag: [t.string, t.regexp], color: "var(--syntax-string)" },
  { tag: t.comment, color: "var(--muted)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--teal)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName, t.tagName, t.attributeName], color: "var(--syntax-fn)" },
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

export interface CodeEditorProps {
  doc: string;
  docVersion: number;               // bump to replace the document (after save, merge or an outside change)
  /** Take every change of `doc` made elsewhere, not only version bumps: another pane editing the same page. */
  follow?: boolean;
  language: "markdown" | "text";
  live: boolean;
  readOnly: boolean;
  lineNumbers: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  titles: () => string[];
  onOpenLink: (target: string, split: boolean) => void;
  reveal?: { line: number; col?: number; at: number } | null;
  placeholder?: string;
  /** A notebook page's rich editing (NS-3A): toolbar, slash menu, pasted and dropped pictures, and in Live the
   *  rendered blocks. Read through `latest`, so the page may pass a new object on every render. Memory notes pass none. */
  rich?: RichContext;
  /** Changes when what the rich view shows from outside changed (the picture grant, the page list): it redraws. */
  richStamp?: unknown;
  /** A file tab's power editing (NS-6A): several cursors, rectangular selection, macros, line tools, and for a text file
   *  the language of its file name. Memory notes pass none and keep the editor they have always had. */
  power?: PowerProps;
}

/** `id`: the tab, for the palette to find its editor. `on`: false in modes that draw the page instead of its source.
 *  `language`: a name chosen in the status line to use instead of the one the file name gives. */
export interface PowerProps { id: string; fileName: string; language?: string; on: boolean }

/** The pieces a caller can switch after the editor exists. `power` and `language` exist only for a file tab. */
export interface Switches { preview: Compartment; readOnly: Compartment; gutter: Compartment; rich: Compartment; power?: Compartment; language?: Compartment }

/** Marks a change that came from the document store (another pane), so it is not reported back as an edit. */
const fromStore = Annotation.define<boolean>();

/** The change that turns the editor's `current` text into `next`, the text another pane of the same document typed.
 *  Only the part that differs is replaced, so this editor's cursor and its own undo history stay where they were (Codex
 *  review of 32fd236, D1). */
export function followSpec(current: string, next: string): TransactionSpec | null {
  if (current === next) return null;
  let from = 0;
  const max = Math.min(current.length, next.length);
  while (from < max && current.charCodeAt(from) === next.charCodeAt(from)) from++;
  let a = current.length, b = next.length;
  while (a > from && b > from && current.charCodeAt(a - 1) === next.charCodeAt(b - 1)) { a--; b--; }
  return { changes: { from, to: a, insert: next.slice(from, b) }, annotations: [fromStore.of(true), Transaction.addToHistory.of(false)] };
}

/** Whether a transaction is the user's own edit, to report through `onChange`. */
export const isOwnEdit = (tr: Transaction) => tr.docChanged && !tr.annotation(fromStore);

const readOnlyExt = (on: boolean): Extension => (on ? [EditorState.readOnly.of(true)] : []);
/** Live rendering of rich blocks: a page in Live under the size limit. */
const richOn = (p: CodeEditorProps) => !!p.rich && p.live && p.language === "markdown" && p.doc.length <= RICH_LIMIT;

/** The page's rich context, read from the latest props at the time of each call. */
function latestRich(latest: MutableRefObject<CodeEditorProps>): RichContext {
  const rich = () => latest.current.rich;
  return {
    pictureUrl: (src, wiki) => rich()?.pictureUrl(src, wiki) ?? null,
    readEmbed: (target) => rich()?.readEmbed(target) ?? Promise.resolve(null),
    renderEmbed: (el, page, target) => rich()?.renderEmbed(el, page, target) ?? (() => {}),
    openPage: (target, split) => rich()?.openPage(target, split),
    openHref: (href, split) => rich()?.openHref(href, split),
    get attach() { return rich()?.attach; },
    get attachDropped() { return rich()?.attachDropped; },
    fail: (message) => rich()?.fail(message),
  };
}
const gutterExt = (on: boolean): Extension => (on ? [lineNumbers(), highlightActiveLine()] : []);
let powerExt: Extension | null = null;
const powerOn = (on: boolean): Extension => (on ? (powerExt ??= powerExtensions()) : []);
/** A text file's language: its colours, bracket matching and folding. */
const languageExt = (lang: LanguageSupport | null): Extension => (lang ? [lang, syntaxHighlighting(editorHighlight), bracketMatching(), foldGutter(), keymap.of(foldKeymap)] : []);

/** Everything the editor is made of. For a note (markdown, not read-only, no line numbers) this is the same list, in
 * the same order, as the note editor has always had. */
export function editorExtensions(props: CodeEditorProps, latest: MutableRefObject<CodeEditorProps>, sw: Switches, dark?: () => boolean): Extension[] {
  const rich = props.rich && props.language === "markdown" ? latestRich(latest) : null;
  const markdownOnly = props.language === "markdown"
    ? [
      EditorView.lineWrapping,
      rich ? richLanguage() : markdown({ base: markdownLanguage }),
      syntaxHighlighting(editorHighlight),
      highlightSelectionMatches(),
      autocompletion({ override: [wikilinkSource(() => latest.current.titles()), ...(rich ? [slashSource] : [])], icons: false }),
    ]
    : [highlightSelectionMatches()];
  return [
    history(),
    drawSelection(),
    ...markdownOnly,
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => { latest.current.onSave(); return true; } },
      ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
    ]),
    sw.preview.of(props.live && props.language === "markdown" ? livePreview : []),
    ...(rich && dark ? [richDark.of(dark)] : []),
    ...(rich ? [...richEditing(rich), sw.rich.of(richOn(props) ? richPreview : [])] : []),
    ...(props.power ? [(sw.power ??= new Compartment()).of(powerOn(props.power.on))] : []),
    ...(props.power && props.language === "text" ? [(sw.language ??= new Compartment()).of([])] : []),
    ...(props.placeholder ? [placeholder(props.placeholder)] : []),
    theme,
    sw.readOnly.of(readOnlyExt(props.readOnly)),
    sw.gutter.of(gutterExt(props.lineNumbers)),
    EditorView.updateListener.of((u) => {
      // A macro replay reports once, when it ends (NS-6A); every other edit is reported as it is made.
      if (u.transactions.some((tr) => tr.annotation(replayDone))) latest.current.onChange(u.state.doc.toString());
      else if (u.transactions.some(isOwnEdit) && !isReplaying(u.view)) latest.current.onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      mousedown: (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
        // Cmd+click on macOS, where Ctrl+click is a right click.
        if (!el || !linkClick(e)) return false;
        e.preventDefault();
        latest.current.onOpenLink(el.dataset.wikilink!, e.shiftKey);
        return true;
      },
    }),
  ];
}

/** A CodeMirror editor for a note, a Markdown page or a plain text file. */
export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const sw = useRef<Switches>({ preview: new Compartment(), readOnly: new Compartment(), gutter: new Compartment(), rich: new Compartment() });
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: props.doc, extensions: editorExtensions(props, latest, sw.current, () => documentIsDark(host.current)) }),
    });
    view.current = v;
    // Diagrams draw in the colours of the document, so a change of theme or of the pane's background draws them again.
    let dark = documentIsDark(host.current);
    const stopLook = onDocumentLook(() => {
      const now = documentIsDark(host.current);
      if (now === dark || !latest.current.rich) return;
      dark = now;
      v.dispatch({ effects: richLook.of(null) });
    });
    // Pictures dropped on a page are attached where they land (NS-3A).
    const ctx = v.state.facet(richContextFacet);
    const unregister = ctx ? registerDropTarget(v.dom, async (drop) => dropPictures(v, ctx, drop)) : () => {};
    return () => { stopLook(); unregister(); v.destroy(); view.current = null; };
    // The editor is created once; later prop changes flow through the effects below.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: sw.current.preview.reconfigure(props.live && props.language === "markdown" ? livePreview : []) });
  }, [props.live, props.language]);

  useEffect(() => {
    view.current?.dispatch({ effects: sw.current.readOnly.reconfigure(readOnlyExt(props.readOnly)) });
  }, [props.readOnly]);

  // Power editing follows the mode: on for source, off where the page is drawn (NS-6A).
  const powered = !!props.power?.on;
  useEffect(() => {
    const v = view.current, id = props.power?.id;
    if (!v || !id) return;
    v.dispatch({ effects: sw.current.power?.reconfigure(powerOn(powered)) });
    setEditor(id, powered ? v : null);
    return () => setEditor(id, null);
  }, [powered, props.power?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A text file's language comes in once its grammar has loaded; a stale answer is dropped.
  const languageName = props.power?.language, fileName = props.power?.fileName;
  useEffect(() => {
    if (!fileName || props.language !== "text") return;
    let stale = false;
    void describe(fileName, languageName)
      .then((d) => (d ? support(d) : null))
      .catch(() => null)
      .then((lang) => { if (!stale) view.current?.dispatch({ effects: sw.current.language?.reconfigure(languageExt(lang)) }); });
    return () => { stale = true; };
  }, [fileName, languageName, props.language]); // eslint-disable-line react-hooks/exhaustive-deps

  // The rich view is set up only for a page that has it from the start; past the size limit Live falls back to the
  // plain preview, and comes back when the page is short enough again.
  const rendered = richOn(props);
  useEffect(() => {
    if (props.rich) view.current?.dispatch({ effects: sw.current.rich.reconfigure(rendered ? richPreview : []) });
  }, [rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (props.rich) view.current?.dispatch({ effects: richRefresh.of(null) });
  }, [props.richStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: sw.current.gutter.reconfigure(gutterExt(props.lineNumbers)) });
  }, [props.lineNumbers]);

  const shownVersion = useRef(props.docVersion);
  useEffect(() => {
    const v = view.current;
    const replace = shownVersion.current !== props.docVersion;
    shownVersion.current = props.docVersion;
    if (!v || v.state.doc.toString() === props.doc) return;
    if (replace) {
      const head = Math.min(v.state.selection.main.head, props.doc.length);
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.doc }, selection: { anchor: head } });
    } else if (props.follow) {
      const spec = followSpec(v.state.doc.toString(), props.doc);
      if (spec) v.dispatch(spec);
    }
  }, [props.docVersion, props.follow ? props.doc : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (!v || !props.reveal) return;
    const line = v.state.doc.line(Math.min(props.reveal.line + 1, v.state.doc.lines));
    const at = Math.min(line.from + (props.reveal.col ?? 0), line.to);
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 24 }) });
    v.focus();
  }, [props.reveal]);

  const toolbarRich = useMemo(() => latestRich(latest), []);
  const editor = <div className={props.language === "markdown" ? "md-editor" : "md-editor text-editor"} ref={host} />;
  const bar = powered ? <PowerBar view={() => view.current} readOnly={props.readOnly} /> : null;
  // The editor keeps its place whether or not the power bar shows: the view is made once in its host, and a host React
  // unmounted and made again would be left empty (a canvas that opens as Source turns the bar on after the first render).
  if (!props.rich || props.language !== "markdown") return <>{bar}{editor}</>;
  return (
    <>
      <Toolbar view={() => view.current} rich={toolbarRich} readOnly={props.readOnly} />
      {bar}
      {editor}
    </>
  );
}
