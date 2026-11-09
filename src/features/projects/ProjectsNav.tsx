import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { list, openWork, type Project } from "../../lib/lm";
import { activeTab, useWorkspace } from "../../workspace/store";
import { useProjectIntent } from "./intent";
import { openCountsByProject } from "./projects";
import { ProjectWizard } from "./ProjectWizard";
import { projectsQuery } from "./useProject";

export function ProjectsNav() {
  const enabled = useProjectsEnabled();
  const openProject = useWorkspace((s) => s.openProject);
  const selected = useWorkspace((s) => activeTab(s)?.slug);
  const { wizard, openWizard, closeWizard } = useProjectIntent();
  const registry = useQuery({ ...projectsQuery(), enabled });
  // The same keys and calls as the Open work tab and the note palette, so the cache is shared.
  const open = useQuery({ queryKey: ["open", "*"], queryFn: () => openWork({ allDomains: true, limit: 500 }), enabled });
  const rows = useQuery({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }), enabled });
  const all = registry.data?.projects;
  const counts = useMemo(
    () => openCountsByProject(open.data?.items ?? [], rows.data?.notes ?? [], all ?? []),
    [open.data, rows.data, all],
  );
  const live = (all ?? []).filter((p) => p.status !== "archived");
  const archived = (all ?? []).filter((p) => p.status === "archived");

  const item = (p: Project) => (
    <button key={p.slug} className={`tree-item project-item ${selected === p.slug ? "on" : ""}`} title={p.description || p.name}
      onClick={(e) => openProject(p.slug, p.name, { split: e.ctrlKey || e.metaKey })}>
      <span className="project-name">{p.name}</span>
      {p.status !== "active" && <span className={`badge status-${p.status}`}>{p.status}</span>}
      {!!counts.get(p.slug) && <span className="muted small" title="Open action items">{counts.get(p.slug)}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      {enabled && <button className="primary" onClick={openWizard}>New project</button>}
      {!enabled && (
        <div className="banner warn">
          <strong>Projects need a newer Living Memory</strong>
          <span className="small">Update Living Memory to API 2 with the <code>projects</code> command, then reconnect.</span>
        </div>
      )}
      {!!registry.data?.warnings.length && (
        <div className="banner warn"><ul>{registry.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
      )}
      {registry.isLoading && <p className="muted pad">Loading…</p>}
      {registry.error && <p className="error pad">{classify(registry.error).message}</p>}
      {all && !live.length && !archived.length && <p className="muted pad">No projects yet. A project groups the notes, work and repos of one effort.</p>}
      <nav className="tree">{live.map(item)}</nav>
      {!!archived.length && (
        <details className="tree">
          <summary>Archived <span className="muted">{archived.length}</span></summary>
          {archived.map(item)}
        </details>
      )}
      {wizard && (
        <ProjectWizard mode="create" onClose={closeWizard}
          onDone={(slug) => {
            useProjectIntent.getState().requestTriage(slug);
            openProject(slug, registry.data?.projects.find((p) => p.slug === slug)?.name ?? slug);
          }} />
      )}
    </aside>
  );
}
