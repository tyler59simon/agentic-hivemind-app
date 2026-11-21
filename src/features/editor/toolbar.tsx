// The page editor's toolbar (NS-3A): each button inserts or toggles Markdown at the selection. The editor keeps the
// focus: buttons act on mouse down and never take it.
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Bold, Code, Heading, Highlighter, Image, Italic, Link, List, ListOrdered, ListTodo, MessageSquareText, Quote, Sigma, Table } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { attachAt, pictureExt } from "./rich/attach";
import * as C from "./rich/commands";
import type { RichContext } from "./rich/context";

type Run = (state: EditorState) => TransactionSpec;
const ITEMS: { label: string; keys?: string; icon: ReactNode; run: Run }[] = [
  { label: "Bold", keys: "Ctrl+B", icon: <Bold size="1em" />, run: (s) => C.toggleWrap(s, "**") },
  { label: "Italic", keys: "Ctrl+I", icon: <Italic size="1em" />, run: (s) => C.toggleWrap(s, "*") },
  { label: "Highlight", icon: <Highlighter size="1em" />, run: (s) => C.toggleWrap(s, "==") },
  { label: "Heading", icon: <Heading size="1em" />, run: (s) => C.setHeading(s, 2) },
  { label: "Bulleted list", icon: <List size="1em" />, run: (s) => C.toggleLinePrefix(s, "bullet") },
  { label: "Numbered list", icon: <ListOrdered size="1em" />, run: (s) => C.toggleLinePrefix(s, "number") },
  { label: "Task", icon: <ListTodo size="1em" />, run: (s) => C.toggleLinePrefix(s, "task") },
  { label: "Quote", icon: <Quote size="1em" />, run: (s) => C.toggleLinePrefix(s, "quote") },
  { label: "Code", icon: <Code size="1em" />, run: C.toggleCode },
  { label: "Link", icon: <Link size="1em" />, run: C.insertLink },
  { label: "Table", icon: <Table size="1em" />, run: C.insertTable },
  { label: "Callout", icon: <MessageSquareText size="1em" />, run: (s) => C.insertCallout(s) },
  { label: "Math", icon: <Sigma size="1em" />, run: C.insertMath },
];

/** Run a toolbar command in the editor and give it the focus back. */
function act(view: EditorView | null, run: Run) {
  if (!view || view.state.readOnly) return;
  view.dispatch(run(view.state));
  view.focus();
}

export function Toolbar({ view, rich, readOnly }: { view: () => EditorView | null; rich: RichContext; readOnly: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const pick = async (files: FileList | null) => {
    const v = view();
    const attach = rich.attach;
    const pictures = [...(files ?? [])].filter((f) => pictureExt(f.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name));
    if (!v || !attach || !pictures.length) return;
    await attachAt(v, rich, v.state.selection.main.head, pictures.map((f) => f.name),
      async (i) => attach(new Uint8Array(await pictures[i].arrayBuffer()), pictures[i].name));
    v.focus();
  };
  return (
    <div className="md-toolbar" role="toolbar" aria-label="Formatting">
      {ITEMS.map((item) => (
        <button key={item.label} type="button" className="icon-button" disabled={readOnly} aria-label={item.label}
          title={item.keys ? `${item.label} (${item.keys})` : item.label}
          onMouseDown={(e) => { e.preventDefault(); act(view(), item.run); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(view(), item.run); } }}>
          {item.icon}
        </button>
      ))}
      {rich.attach && (
        <>
          <button type="button" className="icon-button" disabled={readOnly} aria-label="Picture" title="Attach a picture"
            onMouseDown={(e) => { e.preventDefault(); picker.current?.click(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.current?.click(); } }}>
            <Image size="1em" />
          </button>
          <input ref={picker} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const files = e.target.files; void pick(files).finally(() => { e.target.value = ""; }); }} />
        </>
      )}
    </div>
  );
}

/** Keys for bold and italic. Ctrl+K stays the app's search. */
export const toolbarKeys = [
  { key: "Mod-b", run: (v: EditorView) => { if (v.state.readOnly) return false; v.dispatch(C.toggleWrap(v.state, "**")); return true; } },
  { key: "Mod-i", run: (v: EditorView) => { if (v.state.readOnly) return false; v.dispatch(C.toggleWrap(v.state, "*")); return true; } },
];
