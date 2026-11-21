// The editor of a `.hmdoc` page (NS-3C): NS-3B's Rich editor over the rich page's schema. The page is the file's JSON:
// the editor is built from the document session's text and hands the whole file back after every change, written in the
// stable key order. Opening a file never writes it: only an edit, or a change to the page's settings, does.
import { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState as PMState, Selection } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { pastedPictures } from "../editor/rich/attach";
import type { RichContext } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { registerDropTarget } from "../notes/drops";
import { attachPictures, PendingPictures, pastedSlice, RichInputRules, richKeys, slashKey, slashPlugin, type SlashState } from "../rich/editing";
import { AtomPopover, LinkPopover } from "../rich/popovers";
import { BlockHandle } from "../rich/RichEditor";
import { SLASH_ITEMS, runSlash, type BlockCommand } from "../rich/slash";
import { RichToolbar } from "../rich/toolbar";
import { withViews } from "../rich/views";
import { insertColumns } from "./blocks/columns";
import { hasHeaderRow, hasRowSpans } from "./blocks/table/grid";
import { tableViews, viewsChanged } from "./blocks/table/plugin";
import { withTableIds } from "./blocks/table/extensions";
import { insertToggle } from "./blocks/toggle";
import { stringifyDocument, type Meta, type TableView } from "./envelope";
import { columnNames, HmdocTools, PageDialog, TableViewDialog } from "./HmdocTools";
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
  /** The notebook's pictures, for the cover. */
  pictures: string[];
  /** What to show for a file the editor cannot hold: the reason it is read-only. */
  invalid(reason: string): ReactNode;
}

type Valid = Extract<Inspected, { ok: true }>;
type Popover = { kind: "atom"; pos: number } | { kind: "link" } | null;
type Dialog = { kind: "page" } | { kind: "view"; pos: number } | null;

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
function tableAt(editor: Editor): { node: PMNode; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return { node: $from.node(d), pos: $from.before(d) };
  return null;
}

export default function HmdocEditor(props: HmdocEditorProps) {
  // Checked again only when the text came from outside: the editor's own writes are the document it already holds.
  const checked = useMemo(() => inspect(props.text), [props.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!checked.ok) return <>{props.invalid(checked.reason)}</>;
  return <Editing {...props} checked={checked} />;
}

function Editing(props: HmdocEditorProps & { checked: Valid }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const meta = useRef<Meta>(props.checked.envelope.meta);
  const last = useRef(props.text);
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
    meta.current = tidy(meta.current, editor.state.doc);
    const text = stringifyDocument(editor.state.doc, meta.current);
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

  useEffect(() => {
    const ctx = () => latest.current.ctx;
    const editor = new Editor({
      element: host.current!,
      editable: !latest.current.readOnly,
      extensions: [
        ...withViews(hmdocExtensions(), { ctx, edit: (pos) => setPopover({ kind: "atom", pos }) }),
        Placeholder.configure({ placeholder: "Start writing…", showOnlyCurrent: true }),
        RichInputRules, PendingPictures, slashPlugin(slashKeys),
        richKeys(() => latest.current.onSave()),
        tableViews(() => meta.current.views ?? {}),
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
          const slice = text ? pastedSlice(view.state.schema, text) : null;
          if (!slice) return false;
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
          if (!node.isAtom || node.type.name === "rawBlock" || !editor.isEditable) return false;
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
  const items = slash ? ITEMS.filter((i) => i.label.toLowerCase().includes(slash.query.trim().toLowerCase())) : [];
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

  const target = dialog?.kind === "view" && editor ? editor.state.doc.nodeAt(dialog.pos) : null;
  const width = meta.current.width ?? "normal";
  return (
    <div className={`rich-editor hmdoc-editor hmdoc-width-${width}`}>
      {editor && (
        <RichToolbar editor={editor} ctx={props.ctx} readOnly={props.readOnly} onLink={() => setPopover({ kind: "link" })} onEdit={(pos) => setPopover({ kind: "atom", pos })}
          extra={<HmdocTools editor={editor} readOnly={props.readOnly}
            onSettings={() => setDialog({ kind: "page" })}
            onTableView={() => { const t = tableAt(editor); if (t) setDialog({ kind: "view", pos: t.pos }); }} />} />
      )}
      <div className="hmdoc-page">
        <Cover meta={meta.current} ctx={props.ctx} editable={!props.readOnly} onCover={(cover) => setMeta({ ...meta.current, cover })} onSettings={() => setDialog({ kind: "page" })} />
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
      {dialog?.kind === "page" && <PageDialog meta={meta.current} pictures={props.pictures} ctx={props.ctx} onChange={setMeta} onClose={() => setDialog(null)} />}
      {target && target.type.name === "table" && dialog?.kind === "view" && (
        <TableViewDialog labels={columnNames(target.firstChild?.childCount ?? 0, headerTexts(target))} rowSpans={hasRowSpans(target)}
          view={meta.current.views?.[target.attrs.id]} onClose={() => setDialog(null)}
          onApply={(view) => setMeta(withView(meta.current, target.attrs.id, view))} />
      )}
    </div>
  );
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
      {meta.cover && (url ? <img src={url} alt="" /> : <span className="rich-missing">Cover not found: {meta.cover}</span>)}
      {editable && <button type="button" className="hmdoc-cover-button" onClick={onSettings}>{meta.cover ? "Change cover" : "Add a cover image"}</button>}
    </div>
  );
}
