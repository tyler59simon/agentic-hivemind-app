// The editor of a `.hmdoc` page (NS-3C): a Tiptap editor over the rich page's schema, built from src/features/rich.
// The page is the file's JSON: the editor is built from the document session's text and hands the whole file back
// after every change, written in the stable key order. Opening a file never writes it: only an edit, or a change to the page's settings, does.
import { Editor, Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState as PMState, Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { webImageNote } from "../../lib/webImage";
import { pastedPictures } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { registerDropTarget } from "../notes/drops";
import { attachPictures, PendingPictures, pastedSlice, RichInputRules, richKeys, slashKey, slashPlugin, type SlashState } from "../rich/editing";
import { AtomPopover, LinkPopover } from "../rich/popovers";
import { BlockHandle } from "../rich/BlockHandle";
import { SLASH_ITEMS, runSlash, type BlockCommand } from "../rich/slash";
import { RichToolbar } from "../rich/toolbar";
import { withViews } from "../rich/views";
import { insertColumns } from "./blocks/columns";
import { DrawingDialog } from "./blocks/DrawingDialog";
import type { Drawing } from "./blocks/drawing";
import { withEmbedViews } from "./blocks/embedViews";
import { isEmbed, type EmbedType } from "./blocks/embeds";
import { CodeRangeDialog, DiagramDialog, GalleryDialog, NoteCardDialog, PdfDialog } from "./blocks/EmbedDialogs";
import { applyDrawing, insertEmbed, updateEmbed, usesPreview } from "./blocks/insert";
import { embedItems } from "./blocks/items";
import { hasHeaderRow, hasRowSpans } from "./blocks/table/grid";
import { tableViews, viewsChanged } from "./blocks/table/plugin";
import { withTableIds } from "./blocks/table/extensions";
import { insertToggle } from "./blocks/toggle";
import { SIZE_LIMIT, stringifyDocument, type Meta, type TableView } from "./envelope";
import { columnNames, HmdocTools, PageDialog, TableViewDialog } from "./HmdocTools";
import { sanitiseSlice } from "./sanitise";
import { hmdocExtensions } from "./schema";
import { inspect, type Inspected } from "./validate";

export interface HmdocEditorProps {
  text: string;
  /** Changes when the text was replaced from outside the editor (a load, a reload, a merge, a change on disk). */
  version: number;
  readOnly: boolean;
  onChange(text: string): void;
  onSave(): void;
  ctx: RichContext;
  /** Changes when pictures must be drawn again. */
  ctxStamp?: unknown;
  /** Move to a heading, from the outline: `line` is its order among the page's headings, from 0 (UI-1). */
  reveal?: { line: number; at: number } | null;
  /** The notebook's pictures, for the cover. */
  pictures: string[];
  /** What to show for a file the editor cannot hold: the reason it is read-only. */
  invalid(reason: string): ReactNode;
}

type Valid = Extract<Inspected, { ok: true }>;
type Popover = { kind: "atom"; pos: number } | { kind: "link" } | null;
type Dialog = { kind: "page" } | { kind: "view"; id: string } | { kind: "embed"; type: Exclude<EmbedType, "excalidraw">; at: number | null } | { kind: "drawing"; existing: Drawing | null } | null;

const ITEMS: BlockCommand[] = [
  ...SLASH_ITEMS,
  { label: "2 columns", hint: "", run: (e) => insertColumns(e, 2) },
  { label: "3 columns", hint: "", run: (e) => insertColumns(e, 3) },
  { label: "4 columns", hint: "", run: (e) => insertColumns(e, 4) },
  { label: "Toggle", hint: "", run: (e) => insertToggle(e) },
];

/** The settings kept for tables that are still in the page. */
function tidy(meta: Meta, doc: PMNode): Meta {
  const ids = new Set<string>();
  doc.descendants((n) => { if (n.type.name === "table" && n.attrs.id) ids.add(n.attrs.id); return true; });
  const views = Object.fromEntries(Object.entries(meta.views ?? {}).filter(([id]) => ids.has(id)));
  const { views: _old, ...rest } = meta;
  return Object.keys(views).length ? { ...rest, views } : rest;
}

/** The table holding the selection, closest first. */
function tableAt(editor: Editor): PMNode | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return $from.node(d);
  return null;
}

/** The table with this id. */
function tableWithId(doc: PMNode, id: string): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((n) => { if (!found && n.type.name === "table" && n.attrs.id === id) found = n; return !found; });
  return found;
}

export default function HmdocEditor(props: HmdocEditorProps) {
  // The text this editor holds: what it wrote or loaded last. Text that is anything else came from outside (R1-1): a
  // load, a merge, or another pane of the same page typing, which changes the text without a new version.
  const own = useRef(props.text);
  const outside = props.text !== own.current;
  const checked = useMemo(() => inspect(props.text), [props.version, outside ? props.text : null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!checked.ok) return <>{props.invalid(checked.reason)}</>;
  return <Editing {...props} checked={checked} own={own} />;
}

function Editing(props: HmdocEditorProps & { checked: Valid; own: { current: string } }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const meta = useRef<Meta>(props.checked.envelope.meta);
  const last = props.own;
  /** The last state and settings that were written: what a change the page cannot take goes back to. */
  const good = useRef<{ state: PMState; meta: Meta } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const slashKeys = useRef<((key: string) => boolean) | null>(null);
  const [, setTick] = useState(0);
  const [popover, setPopover] = useState<Popover>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [slashIndex, setSlashIndex] = useState(0);

  /** Hand the file's text to the document session when it differs from what it holds. */
  const commit = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = tidy(meta.current, editor.state.doc);
    const text = stringifyDocument(editor.state.doc, next);
    if (text.length > SIZE_LIMIT && good.current) {
      // A file over the limit would open as read-only JSON, and take Undo with it: the change is not made (R1-11).
      meta.current = good.current.meta;
      const store = (editor.storage as unknown as Record<string, { state: PMState | null }>).hmdocBeforeState;
      editor.view.updateState(store.state ?? good.current.state);
      // The refused state is what the update just recorded as the one before: it is not kept (R3-3).
      store.state = null;
      setTick((t) => t + 1);
      latest.current.ctx.fail(`A page can hold ${SIZE_LIMIT.toLocaleString("en-US")} characters of text and settings, and this change would go past that, so it was not made.`);
      return;
    }
    meta.current = next;
    good.current = { state: editor.state, meta: next };
    if (text === last.current) return;
    last.current = text;
    latest.current.onChange(text);
  };

  const load = (editor: Editor, c: Valid, text: string) => {
    setPopover(null);
    setDialog(null);
    meta.current = c.envelope.meta;
    last.current = text;
    const doc = withTableIds(c.doc);
    editor.view.updateState(PMState.create({ doc, plugins: editor.state.plugins, selection: Selection.atStart(doc) }));
    good.current = { state: editor.state, meta: meta.current };
    setTick((t) => t + 1);
  };

  /** A change to the page's settings: saved with the page, and drawn now. */
  const setMeta = (next: Meta) => {
    const editor = editorRef.current;
    if (!editor) return;
    meta.current = next;
    viewsChanged(editor.view);
    commit();
    setTick((t) => t + 1);
  };

  /** A change to some of the page settings, applied to the settings as they are when it arrives: a cover that was being
   *  attached while the width changed must not bring the old width back (R1-17). */
  const patchMeta = (patch: Partial<Meta>) => {
    const next = { ...meta.current, ...patch };
    if (next.width === "normal") delete next.width;
    if (!next.cover) delete next.cover;
    setMeta(next);
  };
  /** What the sorted copy of a table asks of the page. */
  const copyActions = useRef({ clear: (_id: string) => {}, open: (_id: string) => {} });
  copyActions.current = {
    clear: (id) => {
      const view = meta.current.views?.[id];
      if (!view || !editorRef.current?.isEditable) return;
      const { sort: _sort, ...rest } = view;
      setMeta(withView(meta.current, id, rest.filter ? rest : undefined));
    },
    open: (id) => { if (editorRef.current?.isEditable) setDialog({ kind: "view", id }); },
  };

  /** Open the picker of an embed, or the drawing editor; `at` is the embed being changed, none for a new one (NS-3D). */
  const openEmbed = (type: EmbedType, at: number | null = null) => {
    if (type === "excalidraw") {
      const a = at === null ? undefined : editorRef.current?.state.doc.nodeAt(at)?.attrs;
      setDialog({ kind: "drawing", existing: a ? { scene: a.scene, preview: a.preview } : null });
    } else setDialog({ kind: "embed", type, at });
  };
  /** A double-click or Edit on an atom: an embed opens its picker, any other atom its small editor. */
  const editAt = (pos: number) => {
    const node = editorRef.current?.state.doc.nodeAt(pos);
    if (node && isEmbed(node.type.name)) openEmbed(node.type.name, pos);
    else setPopover({ kind: "atom", pos });
  };
  const inserts = useMemo(() => embedItems((type) => openEmbed(type), (message) => latest.current.ctx.fail(message)), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ctx = () => latest.current.ctx;
    const editor = new Editor({
      element: host.current!,
      editable: !latest.current.readOnly,
      extensions: [
        ...withEmbedViews(withViews(hmdocExtensions(), { ctx, edit: editAt }), { ctx, edit: editAt }),
        Placeholder.configure({ placeholder: "Start writing…", showOnlyCurrent: true }),
        RichInputRules, PendingPictures, slashPlugin(slashKeys),
        richKeys(() => latest.current.onSave()),
        // The state just before the latest transaction: a refused change goes back to exactly it, so the cursor and the
        // selection moves made since the last accepted change stay (R2-3).
        Extension.create<unknown, { state: PMState | null }>({
          name: "hmdocBeforeState",
          addStorage: () => ({ state: null }),
          addProseMirrorPlugins() {
            const storage = this.storage;
            return [new Plugin({ view: () => ({ update: (_view, prev) => { storage.state = prev; } }) })];
          },
        }),
        tableViews(() => meta.current.views ?? {}, {
          // A sorted table is drawn as a copy by an editor of the same kind that cannot be edited (R1-10).
          render: (doc) => {
            const dom = document.createElement("div");
            const copy = new Editor({
              element: dom, editable: false, content: doc.toJSON(),
              extensions: [...withEmbedViews(withViews(hmdocExtensions(), { ctx, edit: () => {} }), { ctx, edit: () => {} }), tableViews(() => ({}))],
              editorProps: { attributes: { class: "rich-doc markdown hmdoc-doc hm-copy" } },
            });
            return { dom, destroy: () => copy.destroy() };
          },
          clearSort: (id) => copyActions.current.clear(id),
          openView: (id) => copyActions.current.open(id),
        }),
      ],
      editorProps: {
        attributes: { class: "rich-doc markdown hmdoc-doc", spellcheck: "true", "aria-label": "Page text" },
        clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, "\n\n"),
        handlePaste: (view, event) => {
          const c = ctx();
          const pictures = pastedPictures(event.clipboardData);
          if (pictures.length && c.attach && editor.isEditable) {
            const attach = c.attach;
            void attachPictures(editor, c, view.state.selection.from, pictures.map((p) => p.name), async (i) => attach(new Uint8Array(await pictures[i].file.arrayBuffer()), pictures[i].name));
            return true;
          }
          if (view.state.selection.$from.parent.type.spec.code) return false;
          if (event.clipboardData?.getData("text/html")) return false;
          const text = event.clipboardData?.getData("text/plain");
          const pasted = text ? pastedSlice(view.state.schema, text) : null;
          if (!pasted) return false;
          // This path does not go through transformPasted, so the slice is cleaned here (R1-12).
          const slice = sanitiseSlice(pasted);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        },
        handleClick: (view, pos, event) => {
          if (!(event.ctrlKey || event.metaKey)) return false;
          const link = view.state.doc.resolve(pos).marks().find((m) => m.type.name === "link");
          if (!link) return false;
          ctx().openHref(link.attrs.href, event.shiftKey);
          return true;
        },
        handleDoubleClickOn: (_view, pos, node) => {
          // An embed's own view opens its picker on a double-click.
          if (!node.isAtom || node.type.name === "rawBlock" || isEmbed(node.type.name) || !editor.isEditable) return false;
          setPopover({ kind: "atom", pos });
          return true;
        },
      },
      onTransaction: () => setTick((t) => t + 1),
      onUpdate: commit,
    });
    editorRef.current = editor;
    load(editor, latest.current.checked, latest.current.text);
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
    if (editor && props.text !== last.current) load(editor, props.checked, props.text);
  }, [props.text]); // eslint-disable-line react-hooks/exhaustive-deps

  // The outline names a heading by its order; the cursor goes to it and it scrolls to the middle of the pane. The
  // selection's own scrollIntoView only brings it inside the scroll area, where the sticky toolbar can cover it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.reveal) return;
    let seen = -1, at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (node.type.name === "heading" && ++seen === props.reveal!.line) at = pos;
      return at < 0;
    });
    if (at < 0) return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(at + 1))));
    editor.view.focus();
    const dom = editor.view.nodeDOM(at);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" });
  }, [props.reveal]);

  // Views follow a change of read-only and of the picture grant, as in NS-3B.
  const drawnFor = useRef({ stamp: props.ctxStamp, readOnly: props.readOnly });
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (drawnFor.current.stamp === props.ctxStamp && drawnFor.current.readOnly === props.readOnly) return;
    drawnFor.current = { stamp: props.ctxStamp, readOnly: props.readOnly };
    if (editor.isEditable === props.readOnly) {
      editor.setEditable(!props.readOnly);
      setPopover(null);
      setDialog(null);
    }
    const views = Object.fromEntries(Object.entries(editor.view.props.nodeViews ?? {}).map(([k, f]) => [k, (...a: Parameters<typeof f>) => f(...a)]));
    editor.view.setProps({ nodeViews: views });
  }, [props.ctxStamp, props.readOnly]);

  const editor = editorRef.current;
  const slash: SlashState | null = editor ? slashKey.getState(editor.state)?.open ?? null : null;
  const items = slash ? [...ITEMS, ...inserts].filter((i) => i.label.toLowerCase().includes(slash.query.trim().toLowerCase())) : [];
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

  const target = dialog?.kind === "view" && editor ? tableWithId(editor.state.doc, dialog.id) : null;
  const width = meta.current.width ?? "normal";
  return (
    <div className={`rich-editor hmdoc-editor hmdoc-width-${width}`}>
      {editor && (
        <RichToolbar editor={editor} ctx={props.ctx} readOnly={props.readOnly} onLink={() => setPopover({ kind: "link" })} onEdit={(pos) => setPopover({ kind: "atom", pos })}
          extra={<HmdocTools editor={editor} readOnly={props.readOnly} inserts={inserts}
            onSettings={() => setDialog({ kind: "page" })}
            onTableView={() => { const t = tableAt(editor); if (t) setDialog({ kind: "view", id: t.attrs.id }); }} />} />
      )}
      <div className="hmdoc-page">
        <Cover meta={meta.current} ctx={props.ctx} editable={!props.readOnly} onCover={(cover) => patchMeta({ cover })} onSettings={() => setDialog({ kind: "page" })} />
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
      {editor && dialog?.kind === "embed" && <EmbedPicker editor={editor} ctx={props.ctx} dialog={dialog} onClose={() => { setDialog(null); editor.commands.focus(); }} />}
      {editor && dialog?.kind === "drawing" && (
        <DrawingDialog ctx={props.ctx} existing={dialog.existing} onClose={() => { setDialog(null); editor.commands.focus(); }}
          apply={(next, replaces) => applyDrawing(editor, next, replaces)} stillUsed={(path) => usesPreview(editor.state.doc, path)} />
      )}
      {dialog?.kind === "page" && <PageDialog meta={meta.current} pictures={props.pictures} ctx={props.ctx} onPatch={patchMeta} onClose={() => setDialog(null)} />}
      {target && dialog?.kind === "view" && (
        <TableViewDialog labels={columnNames(TableMap.get(target).width, headerTexts(target))} rowSpans={hasRowSpans(target)}
          view={meta.current.views?.[target.attrs.id]} onClose={() => setDialog(null)}
          onApply={(view) => setMeta(withView(meta.current, target.attrs.id, view))} />
      )}
    </div>
  );
}

/** The picker of the embed `dialog` names; what it hands back goes into the page, or onto the embed being changed. */
function EmbedPicker({ editor, ctx, dialog, onClose }: { editor: Editor; ctx: RichContext; dialog: Extract<Dialog, { kind: "embed" }>; onClose: () => void }) {
  const initial = dialog.at === null ? null : (editor.state.doc.nodeAt(dialog.at)?.attrs ?? null);
  const pick = (attrs: Record<string, unknown>) => {
    onClose();
    const ok = dialog.at === null ? insertEmbed(editor, dialog.type, attrs) : updateEmbed(editor, dialog.at, dialog.type, attrs);
    if (!ok) ctx.fail("That could not be put into the page.");
  };
  const common = { initial, onPick: pick, onClose };
  switch (dialog.type) {
    case "noteCard": return <NoteCardDialog {...common} />;
    case "diagram": return <DiagramDialog {...common} />;
    case "codeRange": return <CodeRangeDialog {...common} files={ctx.notebook} />;
    case "pdfPage": return <PdfDialog {...common} files={ctx.notebook} />;
    case "gallery": return <GalleryDialog {...common} files={ctx.notebook} attach={ctx.attachPath} fail={ctx.fail} />;
  }
}

/** The text of each cell of a header row, or none when the table has no header row. */
function headerTexts(table: PMNode): string[] {
  if (!hasHeaderRow(table)) return [];
  const out: string[] = [];
  table.firstChild!.forEach((cell) => { for (let i = 0; i < (cell.attrs.colspan ?? 1); i++) out.push(i === 0 ? cell.textContent : ""); });
  return out;
}

function withView(meta: Meta, id: string, view: TableView | undefined): Meta {
  const views = { ...(meta.views ?? {}) };
  if (view) views[id] = view; else delete views[id];
  const { views: _old, ...rest } = meta;
  return Object.keys(views).length ? { ...rest, views } : rest;
}

/** The strip above the page: its cover picture, which a picture can be pasted or dropped on. */
function Cover({ meta, ctx, editable, onCover, onSettings }: {
  meta: Meta; ctx: RichContext; editable: boolean; onCover: (path: string) => void; onSettings: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const latest = useRef({ ctx, editable, onCover });
  latest.current = { ctx, editable, onCover };
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    return registerDropTarget(el, async (drop) => {
      const { ctx: c, editable: ok, onCover: set } = latest.current;
      const attach = c.attachDroppedPath;
      const i = drop.names.findIndex(isPicture);
      if (!attach || !ok || i < 0) return [];
      try { set(await attach(drop.token, i, drop.names[i])); } catch (e) { c.fail(`${drop.names[i]} was not attached: ${e instanceof Error ? e.message : String(e)}`); }
      return [i];
    });
  }, []);
  const paste = (e: React.ClipboardEvent) => {
    const [picture] = pastedPictures(e.clipboardData);
    if (!picture || !ctx.attachPath || !editable) return;
    e.preventDefault();
    const attach = ctx.attachPath;
    void picture.file.arrayBuffer().then((b) => attach(new Uint8Array(b), picture.name)).then(onCover, (err) => ctx.fail(`${picture.name} was not attached: ${err instanceof Error ? err.message : String(err)}`));
  };
  const url = meta.cover ? ctx.pictureUrl(meta.cover, true) : null;
  return (
    <div className={`hmdoc-cover${meta.cover ? " has-cover" : ""}`} ref={strip} tabIndex={editable ? 0 : undefined} onPaste={paste}>
      {meta.cover && (url ? <img src={url} alt="" /> : <span className="rich-missing">{webImageNote(meta.cover) ?? `Cover not found: ${meta.cover}`}</span>)}
      {editable && <button type="button" className="hmdoc-cover-button" onClick={onSettings}>{meta.cover ? "Change cover" : "Add a cover image"}</button>}
    </div>
  );
}
