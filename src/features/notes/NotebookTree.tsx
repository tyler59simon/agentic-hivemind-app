import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronRight, Ellipsis, File, FileText, Folder, FolderPlus, GitBranch, Image as ImageIcon, Inbox, LayoutPanelTop, Plus, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { fileManager } from "../../lib/platform";
import { treeQuery } from "../../documents/io";
import type { Visibility } from "../../lib/lm";
import { isCanvas, isDocx, isDrawio, isMarkdown, isMermaid, isPdf, isRichDoc, isSvg, metaQuery, revealFile, type Notebook } from "../../lib/notebooks";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { activeTab, useWorkspace } from "../../workspace/store";
import { dropOnBoard } from "../canvas/treeDrop";
import { convertToRich, movePath, newCanvas, newDocx, newDrawio, newMermaid, newPage, newRichPage, newSection, newSvg, openPage, renamed, trashPath } from "./actions";
import { openToday } from "./dailyActions";
import { useTemplateIntent } from "./DailyViews";
import { runExport } from "./richActions";
import { ancestors, buildTree, dropTarget, loadOpen, nodeLabel, saveOpen, treeMove, visibleRows, type Node } from "./tree";
import { MoveDialog } from "./MoveDialog";
import { ContextMenu } from "../../ui/ContextMenu";
import { contextMenuKey, menuPointFor } from "../../ui/focus";
import { DeleteConfirm } from "./DeleteConfirm";
import { REACH_TEXT, stricter } from "./reach";
import { openFindInFiles } from "../search/FindInFiles";

const low = (s: string) => s.toLowerCase();
const PAGE = /\.(md|markdown|hmdoc)$/i;
/** Files Windows has a real viewer for: they still open in it. Any other file that is not text opens in a tab (the hex view). */
const SYSTEM_VIEWED = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const label = nodeLabel;

/** Pointer-event dragging (HTML5 drag and drop is unreliable in WebView2 with Tauri's own drop handling). `over` is a
 *  row's path, "" for the notebook's empty space (its top level), or null outside the tree (the drop is cancelled). */
export function useRowDrag(root: string, onDrop: (from: string, target: Node | null) => void, nodes: Map<string, Node>) {
  const [drag, setDrag] = useState<{ path: string; over: string | null } | null>(null);
  const start = useRef<{ path: string; x: number; y: number; pointer: number } | null>(null);
  const dragged = useRef(false);
  useEffect(() => {
    // Only the pointer that pressed the row moves it, and a cancelled gesture (the browser took over scrolling) drops
    // the drag (Codex review of 32fd236, U3).
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.pointer) return;
      if (!drag && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const row = el?.closest<HTMLElement>("[data-tree-path]");
      const inside = el?.closest<HTMLElement>("[data-tree-root]")?.dataset.treeRoot === root;
      setDrag({ path: s.path, over: row && inside ? row.dataset.treePath! : inside ? "" : null });
    };
    // Only the gesture's own pointer ends it (Codex re-review of c496e1c, N6).
    const cancel = (e: PointerEvent) => {
      if (!start.current || e.pointerId !== start.current.pointer) return;
      start.current = null;
      setDrag(null);
    };
    const up = (e: PointerEvent) => {
      if (!start.current || e.pointerId !== start.current.pointer) return;
      start.current = null;
      if (!drag) return;
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }, 0);
      if (drag.over !== null) onDrop(drag.path, drag.over === "" ? null : nodes.get(low(drag.over)) ?? null);
      // A file let go outside the tree goes to a canvas board under the pointer, if there is one; no other place takes it.
      else if (nodes.get(low(drag.path))?.kind !== "dir") dropOnBoard({ notebook: root, path: drag.path }, e.clientX, e.clientY);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [drag, nodes, onDrop, root]);
  return {
    drag,
    /** True right after a drop, so the click that ends a drag does not also open the row. */
    justDragged: () => dragged.current,
    /** A second pointer pressed while a gesture is under way is ignored; the first one keeps its row. */
    down: (path: string, e: React.PointerEvent) => {
      if (e.button === 0 && !start.current) start.current = { path, x: e.clientX, y: e.clientY, pointer: e.pointerId };
    },
  };
}

/** How far agents reach, when it is not the default (searchable): shown beside the notebook's name. */
function reachLabel(reach: { visibility?: Visibility; private?: boolean }) {
  if (reach.private) return "Private";
  return reach.visibility && reach.visibility !== "searchable" ? REACH_TEXT[reach.visibility].label : null;
}

/** One notebook: its header, and its sections and pages as an expandable tree. */
export function NotebookTree({ notebook, onSettings, edits, onEdits }: {
  notebook: Notebook; onSettings: () => void;
  /** Page edits agents proposed to a folder notebook (CON-9) wait in the Inbox's Pages group; `onEdits` opens it. */
  edits?: number; onEdits?: () => void;
}) {
  const client = useQueryClient();
  const tree = useQuery(treeQuery(notebook.id));
  const meta = useQuery(metaQuery(notebook.id));
  const reach = reachLabel(stricter(notebook, (meta.data ?? {}) as Parameters<typeof stricter>[1]));
  const [open, setOpen] = useState(() => loadOpen(notebook.id));
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [naming, setNaming] = useState<{ folder: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ node: Node; x: number; y: number; from: HTMLElement | null } | null>(null);
  // The row Tab reaches in this tree (roving focus, DESK-6): the last one focused, else the open page, else the first.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const treeBox = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const current = useWorkspace((s) => { const t = activeTab(s); return t?.kind === "file" && t.file?.notebook === notebook.id ? t.file.path : undefined; });

  const nodes = useMemo(() => buildTree(tree.data?.entries ?? [], meta.data), [tree.data, meta.data]);
  const byPath = useMemo(() => {
    const map = new Map<string, Node>();
    const walk = (list: Node[]) => list.forEach((n) => { map.set(low(n.path), n); walk(n.children); });
    walk(nodes);
    return map;
  }, [nodes]);
  const rows = visibleRows(nodes, open);
  const tabbable = rows.find((r) => r.node.path === focusPath)?.node.path ?? rows.find((r) => r.node.path === current)?.node.path ?? rows[0]?.node.path;
  const rowEl = (path: string) => [...(treeBox.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find((el) => el.dataset.treePath === path) ?? null;
  const focusRow = (path: string) => { setFocusPath(path); requestAnimationFrame(() => { const el = rowEl(path); el?.focus(); el?.scrollIntoView({ block: "nearest" }); }); };
  const fail = (e: unknown) => toast(classify(e).message, "error");

  const toggle = (path: string, on?: boolean) => setOpen((was) => {
    const next = new Set(was);
    const key = low(path);
    if (on ?? !next.has(key)) next.add(key); else next.delete(key);
    saveOpen(notebook.id, next);
    return next;
  });
  // Opening a page from elsewhere (a link, the palette) shows where it lives.
  useEffect(() => {
    if (!current) return;
    const need = ancestors(current).filter((a) => !open.has(a));
    if (!need.length) return;
    setOpen((was) => { const next = new Set([...was, ...need]); saveOpen(notebook.id, next); return next; });
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  const drop = (from: string, target: Node | null) => {
    const to = dropTarget(from, target);
    if (to) movePath(client, notebook.id, from, to).catch(fail);
  };
  const { drag, down, justDragged } = useRowDrag(notebook.id, drop, byPath);

  const pick = (node: Node, e: { ctrlKey: boolean; metaKey: boolean }) => {
    if (node.kind === "dir") return toggle(node.path);
    if (node.kind === "other" && SYSTEM_VIEWED.test(node.path)) return void revealFile(notebook.id, node.path, true).catch(fail);
    openPage({ notebook: notebook.id, path: node.path }, { split: e.ctrlKey || e.metaKey });
  };
  /** The folder new pages go into from a row: a section itself, or a page's subpage folder. */
  const folderFor = (node: Node | null) => (!node ? "" : node.kind === "dir" ? node.path : node.kind === "page" ? node.path.replace(PAGE, "") : node.path.split("/").slice(0, -1).join("/"));
  /** A rich page beside a Markdown page of the same name: the folder they share holds the Markdown page's subpages, so the
   *  rich page has no subpage commands (R1-15). */
  const sharesFolder = (node: Node) => node.kind === "page" && isRichDoc(node.path)
    && [".md", ".markdown"].some((ext) => byPath.get(low(node.path.replace(PAGE, "") + ext))?.kind === "page");
  const create = (node: Node | null) => {
    const folder = folderFor(node);
    newPage(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createRich = (node: Node | null) => {
    const folder = folderFor(node);
    newRichPage(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createCanvas = (node: Node | null) => {
    const folder = folderFor(node);
    newCanvas(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createMermaid = (node: Node | null) => {
    const folder = folderFor(node);
    newMermaid(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createSvg = (node: Node | null) => {
    const folder = folderFor(node);
    newSvg(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createDrawio = (node: Node | null) => {
    const folder = folderFor(node);
    newDrawio(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const createDocx = (node: Node | null) => {
    const folder = folderFor(node);
    newDocx(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  /** Keep the new name. After Enter the focus goes back to the row; after a blur it stays where the user moved it. */
  const commitRename = (refocus = false) => {
    const r = renaming;
    setRenaming(null);
    if (r && refocus) focusRow(r.path);
    if (!r || !r.value.trim() || r.value.trim() === label(byPath.get(low(r.path))!)) return;
    movePath(client, notebook.id, r.path, renamed(r.path, r.value, byPath.get(low(r.path))?.kind === "dir")).catch(fail);
  };
  const commitSection = () => {
    const n = naming;
    setNaming(null);
    if (!n?.value.trim()) return;
    newSection(client, notebook.id, n.folder, n.value).then((path) => { if (n.folder) toggle(n.folder, true); toggle(path, true); }, fail);
  };
  /** Keys on a focused row (DESK-6). Fields inside the row (rename) keep their own keys. */
  const rowKey = (e: React.KeyboardEvent<HTMLDivElement>, at: number) => {
    if (e.target !== e.currentTarget) return;
    const node = rows[at].node;
    if (contextMenuKey(e)) { e.preventDefault(); setMenu({ node, ...menuPointFor(e.currentTarget), from: e.currentTarget }); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(node, e); return; }
    if (e.key === "F2") { e.preventDefault(); setRenaming({ path: node.path, value: label(node) }); return; }
    if (e.key === "Delete") { e.preventDefault(); remove(node); return; }
    const move = treeMove(rows, at, e.key);
    if (!move) return;
    e.preventDefault();
    if ("focus" in move) focusRow(rows[move.focus].node.path);
    else toggle("expand" in move ? move.expand : move.collapse, "expand" in move);
  };
  /** Move a page or section without dragging (WCAG 2.5.7): pick the section or page it goes under. */
  const moveTo = (node: Node) => setDialog(
    <MoveDialog node={node} targets={[...byPath.values()]} onClose={() => setDialog(null)}
      onMove={(target) => { setDialog(null); drop(node.path, target); }} />,
  );
  const remove = (node: Node) => setDialog(
    <DeleteConfirm notebook={notebook.id} path={node.path} section={node.kind === "dir"}
      onAnswer={(yes) => { setDialog(null); if (yes) trashPath(client, notebook.id, node.path).catch(fail); }} />,
  );

  return (
    <section className="notebook">
      <div className="notebook-head">
        <button className="notebook-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} title={notebook.path}>
          {collapsed ? <ChevronRight size="1.1em" aria-hidden /> : <ChevronDown size="1.1em" aria-hidden />}
          <span className="grow">{notebook.title}</span>
          {reach && <span className="badge">{reach}</span>}
        </button>
        {!!edits && (
          <button className="icon-button proposals-badge" title={`${edits} proposed ${edits === 1 ? "edit" : "edits"} from agents, waiting in the Inbox`}
            onClick={onEdits}><Inbox size="1em" aria-hidden />{edits} agent {edits === 1 ? "edit" : "edits"}</button>
        )}
        <button className="icon-button" title="Today's daily page" aria-label="Today" onClick={() => openToday(client, notebook.id).catch(fail)}><CalendarDays size="1.1em" aria-hidden /></button>
        <button className="icon-button" title="New page" aria-label="New page" onClick={() => create(null)}><Plus size="1.1em" aria-hidden /></button>
        <button className="icon-button" title="New section" aria-label="New section" onClick={() => setNaming({ folder: "", value: "" })}><FolderPlus size="1.1em" aria-hidden /></button>
        <Menu label="Notebook actions" align="right" button={<Ellipsis size="1.1em" aria-hidden />} className="icon-menu">
          {(close) => (
            <>
              <li><button role="menuitem" onClick={() => { close(); useTemplateIntent.getState().open(notebook.id); }}>New page from template…</button></li>
              {<li><button role="menuitem" onClick={() => { close(); createRich(null); }}>New rich page</button></li>}
              {<li><button role="menuitem" onClick={() => { close(); createCanvas(null); }}>New canvas</button></li>}
              {<li><button role="menuitem" onClick={() => { close(); createMermaid(null); }}>New Mermaid diagram</button></li>}
              {<li><button role="menuitem" onClick={() => { close(); createDrawio(null); }}>New Draw.io diagram</button></li>}
              {<li><button role="menuitem" onClick={() => { close(); createSvg(null); }}>New SVG</button></li>}
              {<li><button role="menuitem" onClick={() => { close(); createDocx(null); }}>New Word document</button></li>}
              <li><button role="menuitem" onClick={() => { close(); onSettings(); }}>Notebook settings…</button></li>
              <li><button role="menuitem" onClick={() => { close(); revealFile(notebook.id, null).catch(fail); }}>Show in {fileManager()}</button></li>
              {<li><button role="menuitem" onClick={() => { close(); openFindInFiles({ notebook: notebook.id }); }}>Find in files…</button></li>}
              <li><button role="menuitem" onClick={() => { close(); client.invalidateQueries({ queryKey: ["notebook-tree", notebook.id] }); }}>Refresh</button></li>
            </>
          )}
        </Menu>
      </div>
      {!collapsed && (
        <div ref={treeBox} className={`notebook-tree ${drag?.over === "" ? "drop" : ""}`} role="tree" aria-label={notebook.title} data-tree-root={notebook.id}>
          {naming && naming.folder === "" && (
            <input className="tree-input" autoFocus placeholder="Section name" value={naming.value} aria-label="Section name"
              onChange={(e) => setNaming({ ...naming, value: e.target.value })} onBlur={commitSection}
              onKeyDown={(e) => { if (e.key === "Enter") commitSection(); else if (e.key === "Escape") setNaming(null); }} />
          )}
          {tree.isLoading && <p className="muted pad">Reading the folder…</p>}
          {tree.error && <p className="error pad">{classify(tree.error).message}</p>}
          {tree.data && !rows.length && !naming && <p className="muted pad">No pages yet. <button className="link" onClick={() => create(null)}>Create one</button></p>}
          {rows.map(({ node, depth, open: isOpen, posinset, setsize }, at) => {
            // A rich page has its own icon, so it is told from the Markdown page of the same name (UI-2).
            const Icon = node.kind === "dir" ? Folder : node.kind === "page" ? (isRichDoc(node.path) ? LayoutPanelTop : FileText) : isCanvas(node.path) || isDrawio(node.path) ? Workflow : isMermaid(node.path) ? GitBranch : isSvg(node.path) ? ImageIcon : isDocx(node.path) || isPdf(node.path) ? FileText : File;
            const branch = node.kind === "dir" || node.children.length > 0;
            const target = drag && drag.over && low(drag.over) === low(node.path) && dropTarget(drag.path, node);
            return (
              <div key={node.path} role="none">
                <div role="treeitem" aria-expanded={branch ? isOpen : undefined} aria-selected={current === node.path} data-tree-path={node.path}
                  aria-level={depth + 1} aria-posinset={posinset} aria-setsize={setsize} tabIndex={node.path === tabbable ? 0 : -1}
                  onFocus={(e) => { if (e.target === e.currentTarget) setFocusPath(node.path); }}
                  onKeyDown={(e) => rowKey(e, at)}
                  className={`tree-row ${current === node.path ? "on" : ""} ${target ? "drop" : ""} ${drag?.path === node.path ? "dragging" : ""}`}
                  style={{ paddingLeft: `${depth * 1.1 + 0.2}rem` }}
                  onPointerDown={(e) => down(node.path, e)}
                  onClick={(e) => { if (!justDragged()) pick(node, e); }}
                  onAuxClick={(e) => { if (e.button === 1 && node.kind !== "dir") openPage({ notebook: notebook.id, path: node.path }, { split: true }); }}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ node, x: e.clientX, y: e.clientY, from: e.currentTarget }); }}>
                  <button className="tree-toggle" tabIndex={-1} aria-hidden={!branch} style={{ visibility: branch ? "visible" : "hidden" }}
                    onClick={(e) => { e.stopPropagation(); toggle(node.path); }}>
                    {isOpen ? <ChevronDown size="1em" /> : <ChevronRight size="1em" />}
                  </button>
                  <Icon size="1.05em" aria-hidden className="tree-icon" />
                  {renaming?.path === node.path
                    ? <input className="tree-input" autoFocus value={renaming.value} aria-label="New name" onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} onBlur={() => commitRename()}
                      onKeyDown={(e) => { if (e.key === "Enter") commitRename(true); else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); focusRow(node.path); } }} />
                    : <span className="tree-label" title={node.path}>{label(node)}</span>}
                </div>
                {naming && naming.folder === node.path && (
                  <input className="tree-input" style={{ marginLeft: `${(depth + 1) * 1.1 + 1.6}rem` }} autoFocus placeholder="Section name" value={naming.value} aria-label="Section name"
                    onChange={(e) => setNaming({ ...naming, value: e.target.value })} onBlur={commitSection}
                    onKeyDown={(e) => { if (e.key === "Enter") commitSection(); else if (e.key === "Escape") setNaming(null); }} />
                )}
              </div>
            );
          })}
          {tree.data?.truncated && <p className="muted pad">This folder has more than 20,000 entries; only the first are shown.</p>}
        </div>
      )}
      {menu && (
        <ContextMenu at={menu} from={menu.from} label={`${label(menu.node)} actions`} onClose={() => setMenu(null)}>
          {(() => {
            const n = menu.node;
            const item = (text: string, act: () => void, cls = "") => (
              <li role="none"><button role="menuitem" className={cls} onClick={() => { setMenu(null); act(); }}>{text}</button></li>
            );
            return (
              <>
                {n.kind !== "dir" && item("Open beside", () => openPage({ notebook: notebook.id, path: n.path }, { split: true }))}
                {n.kind !== "other" && !sharesFolder(n) && item(n.kind === "dir" ? "New page here" : "New subpage", () => create(n))}
                {n.kind !== "other" && !sharesFolder(n) && item(n.kind === "dir" ? "New rich page here" : "New rich subpage", () => createRich(n))}
                {n.kind === "dir" && item("New canvas here", () => createCanvas(n))}
                {n.kind === "dir" && item("New Mermaid diagram here", () => createMermaid(n))}
                {n.kind === "dir" && item("New Draw.io diagram here", () => createDrawio(n))}
                {n.kind === "dir" && item("New SVG here", () => createSvg(n))}
                {n.kind === "dir" && item("New Word document here", () => createDocx(n))}
                {n.kind === "dir" && item("New page from template…", () => useTemplateIntent.getState().open(notebook.id, folderFor(n)))}
                {n.kind === "page" && isMarkdown(n.path) && item("Convert to rich page", () => convertToRich(client, { notebook: notebook.id, path: n.path }).catch(fail))}
                {n.kind === "page" && isRichDoc(n.path) && item("Export to Markdown…", () => runExport(client, { notebook: notebook.id, path: n.path }, setDialog))}
                {n.kind === "dir" && item("New section here", () => { toggle(n.path, true); setNaming({ folder: n.path, value: "" }); })}
                {n.kind === "dir" && item("Find in files…", () => openFindInFiles({ notebook: notebook.id, sub: n.path }))}
                {item("Rename", () => setRenaming({ path: n.path, value: label(n) }))}
                {item("Move to…", () => moveTo(n))}
                {n.kind === "other" && item("Open with default app", () => revealFile(notebook.id, n.path, true).catch(fail))}
                {item(`Show in ${fileManager()}`, () => revealFile(notebook.id, n.path).catch(fail))}
                {item(n.kind === "dir" ? "Delete section…" : "Delete…", () => remove(n), "danger-text")}
              </>
            );
          })()}
        </ContextMenu>
      )}
      {dialog}
    </section>
  );
}
