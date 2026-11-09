import { useQuery } from "@tanstack/react-query";
import { useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import type { System } from "../../lib/lm";
import { activeTab, useWorkspace } from "../../workspace/store";
import { SystemWizard } from "./SystemWizard";
import { systemsQuery, useSystemIntent } from "./useSystem";

export function SystemsNav() {
  const enabled = useSystemsEnabled();
  const openSystem = useWorkspace((s) => s.openSystem);
  const selected = useWorkspace((s) => { const tab = activeTab(s); return tab?.kind === "system" ? tab.slug : undefined; });
  const { wizard, openWizard, closeWizard } = useSystemIntent();
  const registry = useQuery({ ...systemsQuery(), enabled });
  const all = registry.data?.systems;
  const live = (all ?? []).filter((s) => s.status !== "retired");
  const retired = (all ?? []).filter((s) => s.status === "retired");

  const item = (s: System) => (
    <button key={s.slug} className={`tree-item project-item ${selected === s.slug ? "on" : ""}`} title={s.description || s.name}
      onClick={(e) => openSystem(s.slug, s.name, { split: e.ctrlKey || e.metaKey })}>
      <span className="project-name">{s.name}</span>
      {s.status !== "active" && <span className={`badge status-${s.status}`}>{s.status}</span>}
      {!s.repos.length && <span className="muted small" title="No repositories: a system you depend on but do not own">external</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      {enabled && <button className="primary" onClick={openWizard}>New system</button>}
      {!enabled && (
        <div className="banner warn">
          <strong>Systems need a newer Living Memory</strong>
          <span className="small">Update Living Memory to a version with the <code>systems</code> command, then reconnect.</span>
        </div>
      )}
      {!!registry.data?.warnings.length && (
        <div className="banner warn"><ul>{registry.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
      )}
      {registry.isLoading && <p className="muted pad">Loading…</p>}
      {registry.error && <p className="error pad">{classify(registry.error).message}</p>}
      {all && !all.length && <p className="muted pad">No systems yet. A system is something you run or depend on: a service, an app, a platform.</p>}
      <nav className="tree">{live.map(item)}</nav>
      {!!retired.length && (
        <details className="tree">
          <summary>Retired <span className="muted">{retired.length}</span></summary>
          {retired.map(item)}
        </details>
      )}
      {wizard && <SystemWizard mode="create" onClose={closeWizard} onDone={(slug, name) => openSystem(slug, name)} />}
    </aside>
  );
}
