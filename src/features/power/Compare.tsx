// The Compare tab (NS-6A): two files side by side with their differences marked. Both files are open documents of the
// store, so copying a change across edits that document like typing in it would (it is unsaved until saved, with a draft),
// and it never writes a file itself. Undo copy puts the text back.
import { MergeView } from "@codemirror/merge";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileRef } from "../../documents/keys";
import { isUnsaved, type DocState } from "../../documents/session";
import { edit, keyOf, open, useDocuments } from "../../documents/store";
import { fileName } from "../../lib/notebooks";
import { toast } from "../../ui/toast";
import type { Tab } from "../../workspace/store";
import { followSpec } from "../editor/CodeEditor";
import { saveFileTab } from "../notes/FileTab";
import { alignment, chunkAt, copyHunk, diffConfig, LINE_PX, stepChunk, type Gap, type Side } from "./hunks";

/** Empty rows that keep the shorter side level with the longer (see `alignment`). Their height is fixed, so nothing about
 *  them is measured. */
class GapWidget extends WidgetType {
  constructor(readonly lines: number) { super(); }
  eq(other: GapWidget) { return other.lines === this.lines; }
  get estimatedHeight() { return this.lines * LINE_PX; }
  ignoreEvent() { return true; }
  toDOM() {
    const row = document.createElement("div");
    row.className = "cm-compare-gap";
    row.style.height = `${this.lines * LINE_PX}px`;
    return row;
  }
}
const setGaps = StateEffect.define<Gap[]>();
const gapField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setGaps)) continue;
      const sorted = [...e.value].sort((x, y) => x.pos - y.pos);
      return Decoration.set(sorted.map((g) => Decoration.widget({ widget: new GapWidget(g.lines), block: true, side: g.below ? 1 : -1 }).range(g.pos)));
    }
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
/** Lines are one fixed height and never wrap, so the sides can be lined up from the changes alone. */
const lineLook = EditorView.theme({
  "&": { fontSize: ".93rem" },
  ".cm-content": { fontFamily: "var(--font-mono)" },
  ".cm-line": { height: `${LINE_PX}px`, lineHeight: `${LINE_PX}px`, padding: "0 6px" },
});

/** Put the gaps the two sides need in both editors. The view's own measuring is switched off: it did not keep the sides
 *  level here (and could restart CodeMirror's measure loop endlessly), and this does not depend on layout. */
function realign(view: MergeView) {
  const gaps = alignment(view.chunks, view.a.state.doc, view.b.state.doc);
  view.a.dispatch({ effects: setGaps.of(gaps.filter((g) => g.side === "a")) });
  view.b.dispatch({ effects: setGaps.of(gaps.filter((g) => g.side === "b")) });
}

/** A copy made from this tab, to undo: the document, its text before, and the text the copy made. */
interface Copied { key: string; before: string; after: string }

/** Why a side cannot take a copy, or null when it can. */
function refusal(doc: DocState | undefined): string | null {
  if (!doc || doc.status === "loading") return "This file is still opening";
  if (doc.status === "error") return "This file could not be opened";
  if (doc.status === "readOnly") return doc.base?.readOnly ?? "This file is read-only";
  return null;
}
const ready = (doc: DocState | undefined) => !!doc && doc.status !== "loading" && doc.status !== "error";

function Name({ file, doc }: { file: FileRef; doc: DocState | undefined }) {
  return (
    <span className="compare-name" title={file.path}>
      {fileName(file.path)}{isUnsaved(doc) && <><span className="dot" aria-hidden> ●</span><span className="visually-hidden">, unsaved</span></>}
    </span>
  );
}

export function CompareTab({ tab }: { tab: Tab }) {
  const { left, right } = tab.compare!;
  const keyL = keyOf(left), keyR = keyOf(right);
  const docL = useDocuments((s) => s.docs[keyL]);
  const docR = useDocuments((s) => s.docs[keyR]);
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  const [ignore, setIgnore] = useState(false);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState<number | null>(null);
  const [copies, setCopies] = useState<Copied[]>([]);
  const textL = docL?.text ?? "", textR = docR?.text ?? "";
  const both = ready(docL) && ready(docR);

  useEffect(() => { void open(left); void open(right); }, [keyL, keyR]); // eslint-disable-line react-hooks/exhaustive-deps

  // The view is made once both files are there, and again when the whitespace setting changes (its chunks are computed
  // with the setting).
  useEffect(() => {
    if (!both || !host.current) return;
    const frozen = [lineLook, gapField, EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new MergeView({
      parent: host.current, a: { doc: textL, extensions: frozen }, b: { doc: textR, extensions: frozen },
      highlightChanges: true, gutter: true, diffConfig: diffConfig(ignore),
    });
    (view as unknown as { measure: () => void }).measure = () => {};
    realign(view);
    // Long lines scroll sideways, both sides together.
    let from: HTMLElement | null = null;
    const follow = (source: EditorView, target: EditorView) => source.scrollDOM.addEventListener("scroll", () => {
      if (from && from !== source.scrollDOM) return;
      from = source.scrollDOM;
      target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft;
      requestAnimationFrame(() => { from = null; });
    });
    follow(view.a, view.b);
    follow(view.b, view.a);
    merge.current = view;
    setCount(view.chunks.length);
    setIndex(null);
    return () => { view.destroy(); merge.current = null; };
  }, [both, ignore]); // eslint-disable-line react-hooks/exhaustive-deps

  // A copy from here, typing in another pane, or a save that merged: the view takes the new text where it differs.
  useEffect(() => {
    const view = merge.current;
    if (!view) return;
    for (const [editor, text] of [[view.a, textL], [view.b, textR]] as const) {
      const spec = followSpec(editor.state.doc.toString(), text);
      if (spec) editor.dispatch(spec);
    }
    realign(view);
    setCount(view.chunks.length);
    setIndex((i) => (i === null ? null : view.chunks.length ? Math.min(i, view.chunks.length - 1) : null));
  }, [textL, textR]);

  /** Select change `i` in both editors and scroll to it. */
  const show = (i: number | null) => {
    const view = merge.current;
    setIndex(i);
    const chunk = i === null ? undefined : view?.chunks[i];
    if (!view || !chunk) return;
    view.a.dispatch({ selection: { anchor: Math.min(chunk.fromA, view.a.state.doc.length) }, effects: EditorView.scrollIntoView(Math.min(chunk.fromA, view.a.state.doc.length), { y: "center" }) });
    view.b.dispatch({ selection: { anchor: Math.min(chunk.fromB, view.b.state.doc.length) }, effects: EditorView.scrollIntoView(Math.min(chunk.fromB, view.b.state.doc.length), { y: "center" }) });
  };
  const step = (direction: 1 | -1) => show(stepChunk(merge.current?.chunks.length ?? 0, index, direction));

  const copy = (from: Side) => {
    const view = merge.current;
    const at = index ?? (view ? chunkAt(view.chunks, from, view[from].state.selection.main.head) : null);
    const chunk = at === null ? undefined : view?.chunks[at];
    if (!view || !chunk) { toast("Choose a change first: Next change selects one."); return; }
    const to = copyHunk(chunk, from, textL, textR);
    const key = to.to === "b" ? keyR : keyL;
    const was = to.to === "b" ? textR : textL;
    const why = refusal(to.to === "b" ? docR : docL);
    if (why) { toast(`${why}, so nothing was copied.`, "warn"); return; }
    edit(key, to.text);
    setCopies((list) => [...list, { key, before: was, after: to.text }]);
  };
  const undo = () => {
    const last = copies[copies.length - 1];
    if (!last) return;
    setCopies((list) => list.slice(0, -1));
    // Text typed or copied since is not thrown away: the copy is undone only while the file still holds what it made.
    if (useDocuments.getState().docs[last.key]?.text !== last.after) { toast("That file has changed since the copy, so it was not undone.", "warn"); return; }
    edit(last.key, last.before);
  };

  const status = useMemo(() => {
    if (!both) return "";
    if (!count) return textL === textR ? "The files are the same." : "The files differ only in whitespace.";
    return index === null ? `${count} ${count === 1 ? "change" : "changes"}` : `Change ${index + 1} of ${count}`;
  }, [both, count, index, textL, textR]);

  const failed = [docL, docR].map((d, i) => (d?.status === "error" ? `${fileName((i ? right : left).path)}: ${d.error}` : null)).filter(Boolean);
  const canRight = refusal(docR) === null, canLeft = refusal(docL) === null;
  return (
    <div className="note-page compare-page">
      <header className="note-header">
        <div className="note-top">
          <span className="eyebrow">Compare</span>
          <span className="fill" />
        </div>
        <div className="compare-controls" role="toolbar" aria-label="Compare">
          <button onClick={() => step(-1)} disabled={!count} title="Previous change"><ChevronUp size="1.1em" aria-hidden />Previous</button>
          <button onClick={() => step(1)} disabled={!count} title="Next change"><ChevronDown size="1.1em" aria-hidden />Next</button>
          <button onClick={() => copy("a")} disabled={!count || !canRight} title={canRight ? "Copy this change from the left file into the right one" : refusal(docR) ?? ""}>Copy to right<ArrowRight size="1.1em" aria-hidden /></button>
          <button onClick={() => copy("b")} disabled={!count || !canLeft} title={canLeft ? "Copy this change from the right file into the left one" : refusal(docL) ?? ""}><ArrowLeft size="1.1em" aria-hidden />Copy to left</button>
          <button onClick={undo} disabled={!copies.length} title="Undo the last copy"><Undo2 size="1.1em" aria-hidden />Undo copy</button>
          <label className="check"><input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} />Ignore whitespace</label>
          <span className="muted small" role="status">{status}</span>
          <span className="fill" />
          {isUnsaved(docL) && <button onClick={() => void saveFileTab(keyL)}>Save {fileName(left.path)}</button>}
          {isUnsaved(docR) && <button onClick={() => void saveFileTab(keyR)}>Save {fileName(right.path)}</button>}
        </div>
      </header>
      {failed.map((f) => <div key={f} className="banner error note-banner">{f}</div>)}
      {!both && !failed.length && <div className="center muted">Opening the files…</div>}
      {both && <div className="merge-head compare-head"><Name file={left} doc={docL} /><Name file={right} doc={docR} /></div>}
      <div className="merge-host compare-host" ref={host} hidden={!both} />
    </div>
  );
}
