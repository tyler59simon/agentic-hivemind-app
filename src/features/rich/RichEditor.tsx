// Rich mode of a Markdown page (NS-3B): a Tiptap editor with no Markdown syntax showing. The page stays Markdown: the
// editor is built from the page's text, and after every change it hands the text back to the document store, written
// so that untouched blocks keep their exact source. Switching to Rich and back changes nothing.
import { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { NodeSelection, EditorState as PMState, Selection } from "@tiptap/pm/state";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { pastedPictures } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { registerDropTarget } from "../notes/drops";
import { attachPictures, moveTopBlock, PendingPictures, pastedSlice, revealBlock, RichInputRules, richKeys, slashKey, slashPlugin, sliceMarkdown, type SlashState } from "./editing";
import { loadPage, type Original } from "./fromMarkdown";
import { parse } from "./markdown";
import { serialize } from "./preserve";
import { baseExtensions } from "./schema";
import { RichToolbar } from "./toolbar";
import { SLASH_ITEMS, runSlash } from "./slash";
import { AtomPopover, LinkPopover } from "./popovers";
import { withViews } from "./views";

export interface RichEditorProps {
  text: string;
  readOnly: boolean;
  onChange(text: string): void;
  onSave(): void;
  ctx: RichContext;
  /** Changes when pictures or embeds must be drawn again (the picture grant arrived, the notebook's pages changed). */
  ctxStamp?: unknown;
  /** Scroll to a source line (0-based), from the outline. */
  reveal?: { line: number; at: number } | null;
  placeholder?: string;
}

type Popover = { kind: "atom"; pos: number } | { kind: "link" } | null;

/** The top-level block index the source line `line` (0-based) falls in. */
function blockAtLine(text: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) break;
    offset = next + 1;
  }
  const blocks = parse(text).children;
  const i = blocks.findIndex((b) => (b.position?.end.offset ?? 0) >= offset);
  return i < 0 ? blocks.length - 1 : i;
}

export default function RichEditor(props: RichEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const original = useRef<Original | null>(null);
  const last = useRef(props.text);
  const latest = useRef(props);
  latest.current = props;
  const slashKeys = useRef<((key: string) => boolean) | null>(null);
  const [, setTick] = useState(0);
  const [popover, setPopover] = useState<Popover>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  /** Build the document from `text`; the undo history starts again. */
  const load = (editor: Editor, text: string) => {
    // A popover holds a position in the old document (R1-12).
    setPopover(null);
    const page = loadPage(editor.schema, text);
    original.current = page.original;
    last.current = text;
    editor.view.updateState(PMState.create({ doc: page.doc, plugins: editor.state.plugins, selection: Selection.atStart(page.doc) }));
  };

  useEffect(() => {
    const ctx = () => latest.current.ctx;
    const editor = new Editor({
      element: host.current!,
      editable: !latest.current.readOnly,
      extensions: [
        ...withViews(baseExtensions(), { ctx, edit: (pos) => setPopover({ kind: "atom", pos }) }),
        Placeholder.configure({ placeholder: latest.current.placeholder ?? "Start writing…", showOnlyCurrent: true }),
        RichInputRules, PendingPictures, slashPlugin(slashKeys),
        richKeys(() => latest.current.onSave()),
      ],
      editorProps: {
        attributes: { class: "rich-doc markdown", spellcheck: "true", "aria-label": "Page text" },
        clipboardTextSerializer: (slice) => (original.current ? sliceMarkdown(slice, original.current.style, original.current.definitions) : slice.content.textBetween(0, slice.content.size, "\n\n")),
        handlePaste: (view, event) => {
          const c = ctx();
          const pictures = pastedPictures(event.clipboardData);
          if (pictures.length && c.attach && editor.isEditable) {
            const attach = c.attach;
            void attachPictures(editor, c, view.state.selection.from, pictures.map((p) => p.name), async (i) => attach(new Uint8Array(await pictures[i].file.arrayBuffer()), pictures[i].name));
            return true;
          }
          // Text pasted into a code block is the code itself (Codex review of 2392f6b, R1-7).
          if (view.state.selection.$from.parent.type.spec.code) return false;
          if (event.clipboardData?.getData("text/html")) return false;
          const text = event.clipboardData?.getData("text/plain");
          const slice = text ? pastedSlice(view.state.schema, text) : null;
          if (!slice) return false;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        },
        handleClick: (view, pos, event) => {
          // Ctrl+click opens a link (Ctrl+Shift+click: a page in a split), as in Live.
          if (!(event.ctrlKey || event.metaKey)) return false;
          const link = view.state.doc.resolve(pos).marks().find((m) => m.type.name === "link");
          if (!link) return false;
          ctx().openHref(link.attrs.href, event.shiftKey);
          return true;
        },
        handleDoubleClickOn: (_view, pos, node) => {
          if (!node.isAtom || node.type.name === "rawBlock" || !editor.isEditable) return false;
          setPopover({ kind: "atom", pos });
          return true;
        },
      },
      onTransaction: () => setTick((t) => t + 1),
      onUpdate: ({ editor: e }) => {
        if (!original.current) return;
        const text = serialize(e.state.doc, original.current);
        if (text === last.current) return;
        last.current = text;
        latest.current.onChange(text);
      },
    });
    editorRef.current = editor;
    load(editor, latest.current.text);
    // The toolbar and the block handle need the editor: render again now that it exists (R1-8).
    setTick((t) => t + 1);
    // Pictures dropped on the page are attached where they land (as in Live).
    const unregister = registerDropTarget(editor.view.dom, async (drop) => {
      const c = ctx();
      const attach = c.attachDropped;
      if (!attach || !editor.isEditable) return [];
      const taken = drop.names.map((n, i) => (isPicture(n) ? i : -1)).filter((i) => i >= 0);
      if (!taken.length) return [];
      const pos = editor.view.posAtCoords({ left: drop.x, top: drop.y })?.pos ?? editor.state.selection.from;
      void attachPictures(editor, c, pos, taken.map((i) => drop.names[i]), (n) => attach(drop.token, taken[n], drop.names[taken[n]]));
      return taken;
    });
    return () => { unregister(); editor.destroy(); editorRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Text that changed elsewhere (a merge, a reload, an outside edit followed) rebuilds the document.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && props.text !== last.current) load(editor, props.text);
  }, [props.text]);

  // Pictures and embeds draw again when the page's grant or files change, and source boxes and code language fields
  // follow a change of read-only (R1-11): the views are rebuilt.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.isEditable === props.readOnly) {
      editor.setEditable(!props.readOnly);
      setPopover(null);
    }
    // New view functions make ProseMirror draw every node again.
    const views = Object.fromEntries(Object.entries(editor.view.props.nodeViews ?? {}).map(([k, f]) => [k, (...a: Parameters<typeof f>) => f(...a)]));
    editor.view.setProps({ nodeViews: views });
  }, [props.ctxStamp, props.readOnly]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.reveal) return;
    revealBlock(editor.view, blockAtLine(last.current, props.reveal.line));
  }, [props.reveal]);

  const editor = editorRef.current;
  const slash: SlashState | null = editor ? slashKey.getState(editor.state)?.open ?? null : null;
  const items = slash ? SLASH_ITEMS.filter((i) => i.label.toLowerCase().includes(slash.query.trim().toLowerCase())) : [];
  useEffect(() => { setSlashIndex(0); }, [slash?.query, !!slash]); // eslint-disable-line react-hooks/exhaustive-deps
  slashKeys.current = slash && items.length && editor ? (key) => {
    if (key === "ArrowDown") setSlashIndex((i) => (i + 1) % items.length);
    else if (key === "ArrowUp") setSlashIndex((i) => (i - 1 + items.length) % items.length);
    else runSlash(editor, slash, items[Math.min(slashIndex, items.length - 1)], (pos) => setPopover({ kind: "atom", pos }));
    return true;
  } : null;

  const at = (pos: number): CSSProperties | null => {
    if (!editor || !wrap.current) return null;
    try {
      const c = editor.view.coordsAtPos(pos);
      const box = wrap.current.getBoundingClientRect();
      return { left: c.left - box.left, top: c.bottom - box.top + 4 };
    } catch { return null; }
  };

  return (
    <div className="rich-editor">
      {editor && <RichToolbar editor={editor} ctx={props.ctx} readOnly={props.readOnly} onLink={() => setPopover({ kind: "link" })} onEdit={(pos) => setPopover({ kind: "atom", pos })} />}
      <div className="rich-wrap" ref={wrap}>
        <div ref={host} className="rich-host" />
        {editor && !props.readOnly && <BlockHandle editor={editor} wrap={wrap} />}
        {editor && slash && items.length > 0 && (
          <ul className="rich-slash menu" role="listbox" aria-label="Insert block" style={at(slash.to) ?? undefined}>
            {items.map((item, i) => (
              <li key={item.label} role="option" aria-selected={i === slashIndex}>
                <button type="button" className={i === slashIndex ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); runSlash(editor, slash, item, (pos) => setPopover({ kind: "atom", pos })); }}>
                  <span>{item.label}</span><span className="muted">{item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {editor && popover?.kind === "atom" && <AtomPopover editor={editor} pos={popover.pos} style={at(popover.pos)} onClose={() => { setPopover(null); editor.commands.focus(); }} />}
        {editor && popover?.kind === "link" && <LinkPopover editor={editor} style={at(editor.state.selection.from)} onClose={() => { setPopover(null); editor.commands.focus(); }} />}
      </div>
    </div>
  );
}

/** A grip beside the block under the pointer: drag it to move the block, click it to select the block. Pointer
 *  events, because Tauri's file drop handler keeps HTML drag and drop from reaching the page. */
function BlockHandle({ editor, wrap }: { editor: Editor; wrap: React.RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = useState<{ index: number; top: number } | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);

  const blocks = () => {
    const out: { index: number; rect: DOMRect }[] = [];
    let pos = 0;
    editor.state.doc.forEach((node, _o, index) => {
      const dom = editor.view.nodeDOM(pos);
      if (dom instanceof HTMLElement) out.push({ index, rect: dom.getBoundingClientRect() });
      pos += node.nodeSize;
    });
    return out;
  };
  const origin = () => wrap.current?.getBoundingClientRect() ?? new DOMRect();

  useEffect(() => {
    const dom = editor.view.dom;
    const move = (e: PointerEvent) => {
      if (drag.current) return;
      const hit = blocks().find((b) => e.clientY >= b.rect.top && e.clientY <= b.rect.bottom);
      setHover(hit ? { index: hit.index, top: hit.rect.top - origin().top } : null);
    };
    dom.addEventListener("pointermove", move);
    return () => dom.removeEventListener("pointermove", move);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = (y: number) => {
    const list = blocks();
    const below = list.find((b) => y < b.rect.top + b.rect.height / 2);
    return below ? below.index : list.length;
  };

  if (!hover) return null;
  return (
    <>
      <button type="button" className="rich-grip" style={{ top: hover.top }} aria-label="Move block (drag), select block (click)" title="Drag to move, click to select (Alt+Shift+Up or Down moves too)"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { from: hover.index, moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          drag.current.moved = true;
          const to = target(e.clientY);
          const list = blocks();
          const rect = to < list.length ? list[to].rect : list[list.length - 1]?.rect;
          if (rect) setDrop((to < list.length ? rect.top : rect.bottom) - origin().top);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setDrop(null);
          if (!d) return;
          if (!d.moved) {
            let pos = 0;
            for (let i = 0; i < d.from; i++) pos += editor.state.doc.child(i).nodeSize;
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
            editor.commands.focus();
            return;
          }
          moveTopBlock(editor.view, d.from, target(e.clientY));
          editor.commands.focus();
        }}
        onPointerCancel={() => { drag.current = null; setDrop(null); }}>
        ⋮⋮
      </button>
      {drop !== null && <div className="rich-drop-line" style={{ top: drop }} />}
    </>
  );
}
