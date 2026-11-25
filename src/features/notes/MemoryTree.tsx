import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { OTHER_FOLDERS, realProject } from "../../lib/folders";
import { list, type NoteRow, type Project } from "../../lib/lm";
import { useApp } from "../../store";
import { activeTab, useWorkspace } from "../../workspace/store";
import { projectsQuery } from "../projects/useProject";
import { treeMove, visibleRows, type Node } from "./tree";

const PAGE_SIZE = 250;

export async function listMemoryNotes(signal: AbortSignal, status: "active" | "any" = "active") {
  const rows = new Map<string, NoteRow>();
  for (let offset = 0; !signal.aborted;) {
    const page = await list({ allDomains: true, status, offset, limit: PAGE_SIZE });
    for (const note of page.notes) rows.set(note.ref, note);
    offset += page.notes.length;
    if (!page.notes.length || offset >= page.total) break;
  }
  signal.throwIfAborted();
  return [...rows.values()];
}

interface Group {
  slug: string | null;
  name: string;
  types: { type: string; notes: NoteRow[] }[];
}

export function groupMemoryNotes(rows: NoteRow[], projects: Project[], picked: string | null | undefined): Group[] {
  const byTag = new Map(projects.map((project) => [project.tag, project]));
  const groups = new Map<Project | null, Map<string, NoteRow[]>>();
  for (const note of rows) {
    const matches = new Set(note.tags.flatMap((tag) => {
      const project = byTag.get(tag);
      return project ? [project] : [];
    }));
    for (const project of matches.size ? matches : [null]) {
      if (picked === OTHER_FOLDERS ? project !== null : picked && project?.slug !== picked) continue;
      const types = groups.get(project) ?? new Map<string, NoteRow[]>();
      const notes = types.get(note.type) ?? [];
      notes.push(note);
      types.set(note.type, notes);
      groups.set(project, types);
    }
  }
  return [...groups].map(([project, types]) => ({
    slug: project?.slug ?? null,
    name: project?.name ?? "Unassigned",
    types: [...types].sort(([a], [b]) => a.localeCompare(b)).map(([type, notes]) => ({
      type,
      notes: notes.sort((a, b) => a.title.localeCompare(b.title) || a.ref.localeCompare(b.ref)),
    })),
  })).sort((a, b) => a.name.localeCompare(b.name) || (a.slug ?? "").localeCompare(b.slug ?? ""));
}

export function useMemoryTree() {
  const enabled = useConnection((s) => s.commands.includes("search"));
  const projectsEnabled = useProjectsEnabled();
  const picked = useApp((s) => s.project);
  const notes = useQuery({ queryKey: ["list", "notes-tree"], queryFn: ({ signal }) => listMemoryNotes(signal), enabled });
  const registry = useQuery({ ...projectsQuery(), enabled: enabled && projectsEnabled });
  const groups = useMemo(() => groupMemoryNotes(notes.data ?? [], projectsEnabled ? registry.data?.projects ?? [] : [],
    projectsEnabled ? picked : null), [notes.data, registry.data, projectsEnabled, picked]);
  const registryPending = projectsEnabled && !registry.data;
  return {
    enabled,
    groups: registryPending ? [] : groups,
    expanded: projectsEnabled ? (picked === OTHER_FOLDERS ? null : realProject(picked) ?? undefined) : undefined,
    loading: notes.isLoading || (projectsEnabled && registry.isLoading),
    error: notes.error ?? (projectsEnabled ? registry.error : null),
    retry: () => { void notes.refetch(); if (projectsEnabled) void registry.refetch(); },
  };
}

/** The groups as the tree `treeMove` and `visibleRows` work on: a project is a branch, its note types are branches and the
 *  notes are leaves. A note listed under two projects is two rows, so a row's path carries the path of its branches. */
export function memoryNodes(groups: Group[]): { nodes: Node[]; notes: Map<string, NoteRow> } {
  const notes = new Map<string, NoteRow>();
  const part = (s: string | null) => encodeURIComponent(s ?? "");
  const nodes = groups.map((group): Node => {
    const groupPath = part(group.slug);
    return {
      path: groupPath, name: group.name, kind: "dir",
      children: group.types.map(({ type, notes: rows }): Node => {
        const typePath = `${groupPath}/${part(type)}`;
        return {
          path: typePath, name: type, kind: "dir",
          children: rows.map((note): Node => {
            const path = `${typePath}/${part(note.ref)}`;
            notes.set(path, note);
            return { path, name: note.title, kind: "page", children: [] };
          }),
        };
      }),
    };
  });
  return { nodes, notes };
}

const low = (s: string) => s.toLowerCase();

export function MemoryTree({ tree }: { tree: ReturnType<typeof useMemoryTree> }) {
  const current = useWorkspace((s) => {
    const tab = activeTab(s);
    return tab?.kind === "note" ? tab.ref : undefined;
  });
  const openNote = useWorkspace((s) => s.openNote);
  const { nodes, notes } = useMemo(() => memoryNodes(tree.groups), [tree.groups]);
  // The branches that show the project picked in the sidebar and the open note. They open when the list or the open note
  // changes, and a branch the user closed stays closed until then.
  const revealed = useMemo(() => {
    const out: string[] = [];
    nodes.forEach((group, g) => {
      let holdsCurrent = false;
      for (const type of group.children) {
        if (!type.children.some((leaf) => notes.get(leaf.path)?.ref === current)) continue;
        out.push(low(type.path));
        holdsCurrent = true;
      }
      if (holdsCurrent || tree.groups[g].slug === tree.expanded) out.push(low(group.path));
    });
    return out;
  }, [nodes, notes, tree.groups, tree.expanded, current]);
  const revealKey = revealed.join("\n");
  const [open, setOpen] = useState(() => new Set(revealed));
  useEffect(() => {
    setOpen((was) => (revealed.every((path) => was.has(path)) ? was : new Set([...was, ...revealed])));
  }, [revealKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The row Tab reaches (roving focus): the last one focused, else the open note, else the first.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const rows = visibleRows(nodes, open);
  const tabbable = rows.find((r) => r.node.path === focusPath)?.node.path
    ?? rows.find((r) => notes.get(r.node.path)?.ref === current)?.node.path ?? rows[0]?.node.path;
  const focusRow = (path: string) => {
    setFocusPath(path);
    requestAnimationFrame(() => {
      const el = [...(box.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find((r) => r.dataset.treePath === path);
      el?.focus();
      el?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const toggle = (path: string, on?: boolean) => setOpen((was) => {
    const next = new Set(was);
    if (on ?? !next.has(low(path))) next.add(low(path)); else next.delete(low(path));
    return next;
  });
  const pick = (node: Node, split: boolean) => {
    const note = notes.get(node.path);
    if (note) openNote(note.ref, { title: note.title, split });
    else toggle(node.path);
  };
  const rowKey = (e: React.KeyboardEvent<HTMLDivElement>, at: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(rows[at].node, e.ctrlKey || e.metaKey); return; }
    const move = treeMove(rows, at, e.key);
    if (!move) return;
    e.preventDefault();
    if ("focus" in move) focusRow(rows[move.focus].node.path);
    else toggle("expand" in move ? move.expand : move.collapse, "expand" in move);
  };
  if (!tree.enabled) return null;
  return (
    <section className="notebook-group" aria-label="Memory notes">
      <h2>Memory notes</h2>
      {tree.loading && <p className="muted small pad" role="status">Loading memory notes…</p>}
      {tree.error && (
        <p className="error small pad">{classify(tree.error).message} <button className="link" onClick={tree.retry}>Retry</button></p>
      )}
      {!tree.loading && !tree.error && !tree.groups.length && <p className="muted small pad">No active memory notes here.</p>}
      {rows.length > 0 && (
        <div ref={box} role="tree" aria-label="Memory notes">
          {rows.map(({ node, depth, open: isOpen, posinset, setsize }, at) => {
            const note = notes.get(node.path);
            return (
              <div key={node.path} role="treeitem" data-tree-path={node.path} title={node.name}
                aria-level={depth + 1} aria-posinset={posinset} aria-setsize={setsize}
                aria-expanded={note ? undefined : isOpen} aria-selected={note ? current === note.ref : false}
                tabIndex={node.path === tabbable ? 0 : -1}
                className={`tree-row memory-row${note && current === note.ref ? " on" : ""}`}
                style={{ paddingLeft: `calc(var(--sp-7) + ${depth} * var(--sp-18))` }}
                onFocus={(e) => { if (e.target === e.currentTarget) setFocusPath(node.path); }}
                onKeyDown={(e) => rowKey(e, at)}
                onClick={(e) => pick(node, e.ctrlKey || e.metaKey)}
                onAuxClick={(e) => { if (e.button === 1 && note) openNote(note.ref, { title: note.title, split: true }); }}>
                {note
                  ? <FileText size="1em" className="tree-icon" aria-hidden />
                  : <><ChevronRight size="1em" className="memory-chevron" aria-hidden /><Folder size="1em" className="tree-icon" aria-hidden /></>}
                <span className="tree-label">{node.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
