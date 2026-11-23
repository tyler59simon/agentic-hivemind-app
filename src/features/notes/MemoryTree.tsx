import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection, useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { OTHER_FOLDERS, realProject } from "../../lib/folders";
import { list, type NoteRow, type Project } from "../../lib/lm";
import { useApp } from "../../store";
import { activeTab, useWorkspace } from "../../workspace/store";
import { projectsQuery } from "../projects/useProject";

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
  const enabled = useConnection((s) => s.commands.includes("list"));
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

function Branch({ name, reveal, children }: { name: string; reveal: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(reveal);
  useEffect(() => { if (reveal) setOpen(true); }, [reveal]);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="memory-branch">
      <summary className="tree-row" title={name}>
        <ChevronRight size="1em" className="memory-chevron" aria-hidden />
        <Folder size="1em" className="tree-icon" aria-hidden />
        <span className="tree-label">{name}</span>
      </summary>
      {open && <div className="memory-branch-content">{children}</div>}
    </details>
  );
}

export function MemoryTree({ tree }: { tree: ReturnType<typeof useMemoryTree> }) {
  const current = useWorkspace((s) => {
    const tab = activeTab(s);
    return tab?.kind === "note" ? tab.ref : undefined;
  });
  const openNote = useWorkspace((s) => s.openNote);
  if (!tree.enabled) return null;
  return (
    <section className="notebook-group" aria-label="Memory notes">
      <h2>Memory notes</h2>
      {tree.loading && <p className="muted small pad" role="status">Loading memory notes…</p>}
      {tree.error && (
        <p className="error small pad">{classify(tree.error).message} <button className="link" onClick={tree.retry}>Retry</button></p>
      )}
      {!tree.loading && !tree.error && !tree.groups.length && <p className="muted small pad">No active memory notes here.</p>}
      {tree.groups.map((group) => (
        <Branch key={group.slug ?? ""} name={group.name}
          reveal={group.slug === tree.expanded || group.types.some(({ notes }) => notes.some((note) => note.ref === current))}>
          {group.types.map(({ type, notes }) => (
            <Branch key={type} name={type} reveal={notes.some((note) => note.ref === current)}>
              {notes.map((note) => (
                <button key={note.ref} type="button" className={`tree-row memory-leaf${current === note.ref ? " on" : ""}`}
                  title={note.title} aria-current={current === note.ref ? "true" : undefined}
                  onClick={(e) => openNote(note.ref, { title: note.title, split: e.ctrlKey || e.metaKey })}
                  onAuxClick={(e) => { if (e.button === 1) openNote(note.ref, { title: note.title, split: true }); }}>
                  <FileText size="1em" className="tree-icon" aria-hidden />
                  <span className="tree-label">{note.title}</span>
                </button>
              ))}
            </Branch>
          ))}
        </Branch>
      ))}
    </section>
  );
}
