import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Ellipsis, File, FileText, Folder, FolderPlus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { classify } from "../../lib/errors";
import { metaQuery, revealFile, treeQuery, type Notebook } from "../../lib/notebooks";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { activeTab, useWorkspace } from "../../workspace/store";
import { unsavedUnder } from "../../documents/store";
import { movePath, newPage, newSection, openPage, renamed, trashPath } from "./actions";
import { ancestors, buildTree, dropTarget, loadOpen, saveOpen, visibleRows, type Node } from "./tree";
import { Confirm } from "../../ui/Modal";

const low = (s: string) => s.toLowerCase();
const PAGE = /\.(md|markdown)$/i;
const label = (node: Node) => (node.kind === "page" ? node.name.replace(PAGE, "") : node.name);

/** Pointer-event dragging (HTML5 drag and drop is unreliable in WebView2 with Tauri's own drop handling). `over` is a
 *  row's path, "" for the notebook's empty space (its top level), or null outside the tree (the drop is cancelled). */
function useRowDrag(root: string, onDrop: (from: string, target: Node | null) => void, nodes: Map<string, Node>) {
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
    const cancel = (e: PointerEvent) => {
      if (start.current && e.pointerId !== start.current.pointer) return;
      start.current = null;
      setDrag(null);
    };
    const up = (e: PointerEvent) => {
      if (start.current && e.pointerId !== start.current.pointer) return;
      start.current = null;
      if (!drag) return;
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }, 0);
      if (drag.over !== null) onDrop(drag.path, drag.over === "" ? null : nodes.get(low(drag.over)) ?? null);
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
    down: (path: string, e: React.PointerEvent) => { if (e.button === 0) start.current = { path, x: e.clientX, y: e.clientY, pointer: e.pointerId }; },
  };
}

/** One registered notebook: its header, and its sections and pages as an expandable tree. */
export function NotebookTree({ notebook, onSettings }: { notebook: Notebook; onSettings: () => void }) {
  const client = useQueryClient();
  const tree = useQuery(treeQuery(notebook.id));
  const meta = useQuery(metaQuery(notebook.id));
  const [open, setOpen] = useState(() => loadOpen(notebook.id));
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [naming, setNaming] = useState<{ folder: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ node: Node; x: number; y: number } | null>(null);
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

  const pick = (node: Node, e: React.MouseEvent) => {
    if (node.kind === "dir") return toggle(node.path);
    if (node.kind === "other") return void revealFile(notebook.id, node.path, true).catch(fail);
    openPage({ notebook: notebook.id, path: node.path }, { split: e.ctrlKey || e.metaKey });
  };
  /** The folder new pages go into from a row: a section itself, or a page's subpage folder. */
  const folderFor = (node: Node | null) => (!node ? "" : node.kind === "dir" ? node.path : node.kind === "page" ? node.path.replace(PAGE, "") : node.path.split("/").slice(0, -1).join("/"));
  const create = (node: Node | null) => {
    const folder = folderFor(node);
    newPage(client, notebook.id, folder).then(() => { if (node) toggle(node.path, true); }, fail);
  };
  const commitRename = () => {
    const r = renaming;
    setRenaming(null);
    if (!r || !r.value.trim() || r.value.trim() === label(byPath.get(low(r.path))!)) return;
    movePath(client, notebook.id, r.path, renamed(r.path, r.value, byPath.get(low(r.path))?.kind === "dir")).catch(fail);
  };
  const commitSection = () => {
    const n = naming;
    setNaming(null);
    if (!n?.value.trim()) return;
    newSection(client, notebook.id, n.folder, n.value).then((path) => { if (n.folder) toggle(n.folder, true); toggle(path, true); }, fail);
  };
  const remove = (node: Node) => {
    // Unsaved edits are not in the files that go to the trash: say so, and name the pages (Codex review of 32fd236, D8).
    const lost = unsavedUnder(notebook.id, node.path);
    setDialog(
      <Confirm title={node.kind === "dir" ? "Delete this section?" : "Delete this page?"} danger action={lost.length ? "Delete and lose my edits" : "Move to trash"}
        message={<>
          <p><code>{node.path}</code>{node.kind === "dir" ? " and everything in it" : ""} moves to the notebook's <code>.hivemind/trash</code> folder.</p>
          {lost.length > 0 && (
            <p className="error">Unsaved edits are lost when {lost.length === 1 ? "this page is" : "these pages are"} deleted: {lost.map((p) => <code key={p}>{p}</code>)}. Save first to keep them in the trash copy.</p>
          )}
        </>}
        onAnswer={(yes) => { setDialog(null); if (yes) trashPath(client, notebook.id, node.path).catch(fail); }} />,
    );
  };

  return (
    <section className="notebook">
      <div className="notebook-head">
        <button className="notebook-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)} title={notebook.path}>
          {collapsed ? <ChevronRight size="1.1em" aria-hidden /> : <ChevronDown size="1.1em" aria-hidden />}
          <span className="grow">{notebook.title}</span>
        </button>
        <button className="icon-button" title="New page" aria-label="New page" onClick={() => create(null)}><Plus size="1.1em" aria-hidden /></button>
        <button className="icon-button" title="New section" aria-label="New section" onClick={() => setNaming({ folder: "", value: "" })}><FolderPlus size="1.1em" aria-hidden /></button>
        <Menu label="Notebook actions" align="right" button={<Ellipsis size="1.1em" aria-hidden />} className="icon-menu">
          {(close) => (
            <>
              <li><button role="menuitem" onClick={() => { close(); onSettings(); }}>Notebook settings…</button></li>
              <li><button role="menuitem" onClick={() => { close(); revealFile(notebook.id, null).catch(fail); }}>Show in Explorer</button></li>
              <li><button role="menuitem" onClick={() => { close(); client.invalidateQueries({ queryKey: ["notebook-tree", notebook.id] }); }}>Refresh</button></li>
            </>
          )}
        </Menu>
      </div>
      {!collapsed && (
        <div className={`notebook-tree ${drag?.over === "" ? "drop" : ""}`} role="tree" aria-label={notebook.title} data-tree-root={notebook.id}>
          {naming && naming.folder === "" && (
            <input className="tree-input" autoFocus placeholder="Section name" value={naming.value} aria-label="Section name"
              onChange={(e) => setNaming({ ...naming, value: e.target.value })} onBlur={commitSection}
              onKeyDown={(e) => { if (e.key === "Enter") commitSection(); else if (e.key === "Escape") setNaming(null); }} />
          )}
          {tree.isLoading && <p className="muted pad">Reading the folder…</p>}
          {tree.error && <p className="error pad">{classify(tree.error).message}</p>}
          {tree.data && !rows.length && !naming && <p className="muted pad">No pages yet. <button className="link" onClick={() => create(null)}>Create one</button></p>}
          {rows.map(({ node, depth, open: isOpen }) => {
            const Icon = node.kind === "dir" ? Folder : node.kind === "page" ? FileText : File;
            const branch = node.kind === "dir" || node.children.length > 0;
            const target = drag && drag.over && low(drag.over) === low(node.path) && dropTarget(drag.path, node);
            return (
              <div key={node.path}>
                <div role="treeitem" aria-expanded={branch ? isOpen : undefined} aria-selected={current === node.path} data-tree-path={node.path}
                  className={`tree-row ${current === node.path ? "on" : ""} ${target ? "drop" : ""} ${drag?.path === node.path ? "dragging" : ""}`}
                  style={{ paddingLeft: `${depth * 1.1 + 0.2}rem` }}
                  onPointerDown={(e) => down(node.path, e)}
                  onClick={(e) => { if (!justDragged()) pick(node, e); }}
                  onAuxClick={(e) => { if (e.button === 1 && node.kind !== "dir") openPage({ notebook: notebook.id, path: node.path }, { split: true }); }}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ node, x: e.clientX, y: e.clientY }); }}>
                  <button className="tree-toggle" tabIndex={-1} aria-hidden={!branch} style={{ visibility: branch ? "visible" : "hidden" }}
                    onClick={(e) => { e.stopPropagation(); toggle(node.path); }}>
                    {isOpen ? <ChevronDown size="1em" /> : <ChevronRight size="1em" />}
                  </button>
                  <Icon size="1.05em" aria-hidden className="tree-icon" />
                  {renaming?.path === node.path
                    ? <input className="tree-input" autoFocus value={renaming.value} aria-label="New name" onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })} onBlur={commitRename}
                      onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }} />
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
        <ul className="menu-list context" role="menu" style={{ top: menu.y, left: menu.x }} ref={(el) => el?.querySelector("button")?.focus()}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onKeyDown={(e) => { if (e.key === "Escape") setMenu(null); }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null); }}>
          {(() => {
            const n = menu.node;
            const item = (text: string, act: () => void, cls = "") => (
              <li role="none"><button role="menuitem" className={cls} onClick={() => { setMenu(null); act(); }}>{text}</button></li>
            );
            return (
              <>
                {n.kind !== "dir" && item("Open beside", () => openPage({ notebook: notebook.id, path: n.path }, { split: true }))}
                {n.kind !== "other" && item(n.kind === "dir" ? "New page here" : "New subpage", () => create(n))}
                {n.kind === "dir" && item("New section here", () => { toggle(n.path, true); setNaming({ folder: n.path, value: "" }); })}
                {item("Rename", () => setRenaming({ path: n.path, value: label(n) }))}
                {item("Show in Explorer", () => revealFile(notebook.id, n.path).catch(fail))}
                {item(n.kind === "dir" ? "Delete section…" : "Delete…", () => remove(n), "danger-text")}
              </>
            );
          })()}
        </ul>
      )}
      {dialog}
    </section>
  );
}
