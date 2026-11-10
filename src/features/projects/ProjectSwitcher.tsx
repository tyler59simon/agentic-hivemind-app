import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Layers, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo } from "react";
import { list, openWork, type Project } from "../../lib/lm";
import { openProject, useApp } from "../../store";
import { Menu } from "../../ui/Menu";
import { useProjectIntent } from "./intent";
import { openCountsByProject } from "./projects";
import { ProjectWizard } from "./ProjectWizard";
import { useCurrentProject } from "./useProject";

/** The sidebar's project picker: every page is scoped to the project chosen here, or to all memory. */
export function ProjectSwitcher() {
  const { enabled, registry, project } = useCurrentProject();
  const picked = useApp((s) => s.project);
  const setProject = useApp((s) => s.setProject);
  const { wizard, openWizard, closeWizard } = useProjectIntent();
  // The same keys and calls as the note palette, so the cache is shared.
  const open = useQuery({ queryKey: ["open", "*"], queryFn: () => openWork({ allDomains: true, limit: 500 }), enabled });
  const rows = useQuery({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }), enabled });
  const all = registry.data?.projects;
  const counts = useMemo(() => openCountsByProject(open.data?.items ?? [], rows.data?.notes ?? [], all ?? []), [open.data, rows.data, all]);
  const live = (all ?? []).filter((p) => p.status !== "archived");
  const archived = (all ?? []).filter((p) => p.status === "archived");
  const warnings = registry.data?.warnings ?? [];

  // Nothing picked yet, or the picked project is gone: start on the most recently updated active project.
  useEffect(() => {
    if (!all || picked === null || (picked && all.some((p) => p.slug === picked))) return;
    const first = [...all].filter((p) => p.status === "active").sort((a, b) => b.updated.localeCompare(a.updated))[0];
    setProject(first?.slug ?? null);
  }, [all, picked, setProject]);

  if (!enabled) {
    return <div className="project-switcher static" title="Projects need Living Memory API 2 with the projects command"><Layers size="1.25em" aria-hidden /><span className="grow">Living Memory</span></div>;
  }

  const item = (p: Project, close: () => void) => (
    <li key={p.slug} role="none">
      <button role="menuitem" title={p.description || p.name} onClick={() => { close(); openProject(p.slug); }}>
        <span className="grow">{p.name}</span>
        {p.status !== "active" && <span className={`badge status-${p.status}`}>{p.status}</span>}
        {!!counts.get(p.slug) && <span className="muted small" title="Open action items">{counts.get(p.slug)}</span>}
        {project?.slug === p.slug && <Check size="1em" aria-hidden />}
      </button>
    </li>
  );

  return (
    <>
      <Menu className="project-switcher" label="Choose a project"
        button={<><Layers size="1.25em" aria-hidden /><span className="grow">{project?.name ?? "All memory"}</span>{!!warnings.length && <TriangleAlert size="1em" className="warn-text" aria-label="Registry warnings" />}<ChevronDown size="1.1em" aria-hidden /></>}>
        {(close) => (
          <>
            {live.map((p) => item(p, close))}
            {!!archived.length && <li className="menu-label" role="none">Archived</li>}
            {archived.map((p) => item(p, close))}
            {!!all?.length && <li className="menu-sep" role="none" />}
            <li role="none">
              <button role="menuitem" onClick={() => { close(); openProject(null); }}>
                <span className="grow">All memory</span>{picked === null && <Check size="1em" aria-hidden />}
              </button>
            </li>
            <li role="none"><button role="menuitem" onClick={() => { close(); openWizard(); }}><Plus size="1em" aria-hidden /><span className="grow">New project…</span></button></li>
            {warnings.map((w) => <li key={w} className="menu-note warn-text" role="none">{w}</li>)}
          </>
        )}
      </Menu>
      {wizard && (
        <ProjectWizard mode="create" onClose={closeWizard}
          onDone={(slug) => { useProjectIntent.getState().requestTriage(slug); openProject(slug); }} />
      )}
    </>
  );
}
