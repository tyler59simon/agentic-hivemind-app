// Lazy-loaded Tiptap rich editor for `.docx` files.
import { Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState as PMState, Selection } from "@tiptap/pm/state";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Code, Highlighter, ImagePlus, Italic, List, ListOrdered,
  Minus, Quote, Redo2, Strikethrough, Subscript as SubIcon, Superscript as SupIcon, Table as TableIcon,
  Underline as UnderlineIcon, Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocxMedia } from "../../lib/docx";
import { toast } from "../../ui/toast";
import { docxExtensions } from "./schema";

const MAX_DOCX_IMAGE_BYTES = 30 * 1024 * 1024;

export interface DocxEditorProps {
  doc: Record<string, unknown>;
  version: number;
  media: Record<string, DocxMedia>;
  readOnly: boolean;
  onChange(doc: Record<string, unknown>): void;
  onAddMedia(mime: string, base64: string): string;
  onSave(): void;
}

const TEXT_COLORS = ["#111827", "#dc2626", "#1a73e8", "#2e7d32", "#7c3aed", "#b45309"];
const HL_COLORS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fecaca", "#f5d0fe"];

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export default function DocxEditor(props: DocxEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const loadedVersion = useRef(props.version);
  const [, setTick] = useState(0);

  const insertImageFile = async (file: File) => {
    const editor = editorRef.current;
    if (!editor || !editor.isEditable) return;
    if (!/^image\/(png|jpeg|jpg|gif|webp|bmp)$/i.test(file.type)) return;
    if (file.size > MAX_DOCX_IMAGE_BYTES) {
      toast("Image is too large for a Word document (30 MB limit).", "warn");
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const mediaId = latest.current.onAddMedia(file.type, bytesToBase64(buf));
    editor.chain().focus().insertContent({ type: "docxImage", attrs: { mediaId, alt: file.name } }).run();
  };

  useEffect(() => {
    const saveShortcut = Extension.create({
      name: "docxSaveShortcut",
      addKeyboardShortcuts() {
        return { "Mod-s": () => { latest.current.onSave(); return true; } };
      },
    });
    const extensions = docxExtensions().map((ext) => {
      if (ext.name !== "docxImage") return ext;
      return ext.extend({
        addNodeView() {
          return ({ node }: { node: PMNode }) => {
            const img = document.createElement("img");
            img.className = "docx-inline-img";
            const sync = (n: PMNode) => {
              const id = String(n.attrs.mediaId ?? "");
              const found = latest.current.media[id];
              img.src = found?.dataUrl ?? "";
              img.alt = String(n.attrs.alt ?? id);
              img.title = found ? img.alt : `Missing image (${id})`;
            };
            sync(node);
            return {
              dom: img,
              update: (next: PMNode) => {
                if (next.type.name !== "docxImage") return false;
                sync(next);
                return true;
              },
            };
          };
        },
      });
    });

    const editor = new Editor({
      element: host.current!,
      editable: !latest.current.readOnly,
      extensions: [...extensions, saveShortcut],
      content: latest.current.doc,
      editorProps: {
        attributes: { class: "rich-doc docx-rich-body", spellcheck: "true", "aria-label": "Word document editor" },
        handlePaste: (_view, event) => {
          const items = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!items.length || !editor.isEditable) return false;
          for (const f of items) void insertImageFile(f);
          return true;
        },
      },
      onTransaction: () => setTick((t) => t + 1),
      onUpdate: ({ editor: e }) => {
        latest.current.onChange(e.getJSON() as Record<string, unknown>);
      },
    });
    editorRef.current = editor;
    setTick((t) => t + 1);
    return () => { editor.destroy(); editorRef.current = null; };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const wantEditable = !props.readOnly;
    if (editor.isEditable !== wantEditable) {
      editor.setEditable(wantEditable, false);
    }
  }, [props.readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || loadedVersion.current === props.version) return;
    loadedVersion.current = props.version;
    const nextDoc = editor.schema.nodeFromJSON(props.doc);
    editor.view.updateState(PMState.create({ doc: nextDoc, plugins: editor.state.plugins, selection: Selection.atStart(nextDoc) }));
    setTick((t) => t + 1);
  }, [props.version, props.doc]);

  const e = editorRef.current;
  const run = (fn: (ed: Editor) => void) => () => { if (e && !props.readOnly) fn(e); };

  return (
    <div className="docx-editor-shell">
      {!props.readOnly && e && (
        <div className="rich-toolbar docx-toolbar" role="toolbar" aria-label="Word formatting">
          <button type="button" onClick={run((ed) => ed.chain().focus().undo().run())} disabled={!e.can().undo()} title="Undo"><Undo2 size="1em" aria-hidden /></button>
          <button type="button" onClick={run((ed) => ed.chain().focus().redo().run())} disabled={!e.can().redo()} title="Redo"><Redo2 size="1em" aria-hidden /></button>
          <span className="canvas-sep" aria-hidden />
          <button type="button" className={e.isActive("paragraph") ? "on" : ""} onClick={run((ed) => ed.chain().focus().setParagraph().run())}>P</button>
          {([1, 2, 3] as const).map((lvl) => (
            <button key={lvl} type="button" className={e.isActive("heading", { level: lvl }) ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleHeading({ level: lvl }).run())}>
              H{lvl}
            </button>
          ))}
          <span className="canvas-sep" aria-hidden />
          <button type="button" className={e.isActive("bold") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleBold().run())} title="Bold"><Bold size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("italic") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleItalic().run())} title="Italic"><Italic size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("underline") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleUnderline().run())} title="Underline"><UnderlineIcon size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("strike") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleStrike().run())} title="Strikethrough"><Strikethrough size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("subscript") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleSubscript().run())} title="Subscript"><SubIcon size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("superscript") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleSuperscript().run())} title="Superscript"><SupIcon size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("code") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleCode().run())} title="Inline code"><Code size="1em" aria-hidden /></button>
          <span className="canvas-sep" aria-hidden />
          <button type="button" className={e.isActive({ textAlign: "left" }) ? "on" : ""} onClick={run((ed) => ed.chain().focus().setTextAlign("left").run())} title="Align left"><AlignLeft size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive({ textAlign: "center" }) ? "on" : ""} onClick={run((ed) => ed.chain().focus().setTextAlign("center").run())} title="Align center"><AlignCenter size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive({ textAlign: "right" }) ? "on" : ""} onClick={run((ed) => ed.chain().focus().setTextAlign("right").run())} title="Align right"><AlignRight size="1em" aria-hidden /></button>
          <span className="canvas-sep" aria-hidden />
          <button type="button" className={e.isActive("bulletList") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleBulletList().run())} title="Bullet list"><List size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("orderedList") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleOrderedList().run())} title="Numbered list"><ListOrdered size="1em" aria-hidden /></button>
          <button type="button" className={e.isActive("blockquote") ? "on" : ""} onClick={run((ed) => ed.chain().focus().toggleBlockquote().run())} title="Quote"><Quote size="1em" aria-hidden /></button>
          <button type="button" onClick={run((ed) => ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())} title="Insert table"><TableIcon size="1em" aria-hidden /></button>
          {e.isActive("table") && (
            <>
              <button type="button" onClick={run((ed) => ed.chain().focus().addRowAfter().run())}>+Row</button>
              <button type="button" onClick={run((ed) => ed.chain().focus().addColumnAfter().run())}>+Col</button>
              <button type="button" onClick={run((ed) => ed.chain().focus().deleteTable().run())}>Del table</button>
            </>
          )}
          <button type="button" onClick={run((ed) => ed.chain().focus().insertContent({ type: "docxPageBreak" }).run())} title="Insert page break"><Minus size="1em" aria-hidden /> Break</button>
          <button type="button" onClick={() => fileInput.current?.click()} title="Insert image"><ImagePlus size="1em" aria-hidden /></button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden
            onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) void insertImageFile(f); }} />
          <span className="canvas-sep" aria-hidden />
          {TEXT_COLORS.map((hex) => (
            <button key={`c-${hex}`} type="button" className="canvas-swatch" style={{ background: hex }} title={`Text color ${hex}`}
              onClick={run((ed) => ed.chain().focus().setMark("docxTextColor", { color: hex }).run())} />
          ))}
          <Highlighter size="0.95em" aria-hidden className="muted" />
          {HL_COLORS.map((hex) => (
            <button key={`h-${hex}`} type="button" className="canvas-swatch" style={{ background: hex }} title={`Highlight ${hex}`}
              onClick={run((ed) => ed.chain().focus().setMark("docxHighlight", { color: hex }).run())} />
          ))}
        </div>
      )}
      <div className="docx-editor-scroll">
        <div className="docx-page-sheet" ref={host} />
      </div>
    </div>
  );
}
