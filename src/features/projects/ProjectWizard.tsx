import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { domains, projects, writeProject, type Project, type ProjectStatus } from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { useWorkspace } from "../../workspace/store";
import { useDirect } from "../plans/DirectDialog";
import {
  changedProject, charterBody, defaultCharterDomain, parseAliases, parseRepos, slugify, validateCreate, validateEdit,
  MAX_DESCRIPTION,
} from "./wizard";

export interface ProjectWizardProps {
  /** "create" makes a project (registry entry, project/<slug> tag and charter note in one step); "edit" updates the registry entry. */
  mode: "create" | "edit";
  /** The project being edited (mode "edit"). */
  project?: Project;
  onClose: () => void;
  /** Called after the write, with the project's slug. */
  onDone?: (slug: string) => void;
}

export function ProjectWizard(props: ProjectWizardProps) {
  return props.mode === "edit" && props.project ? <EditProject {...props} project={props.project} /> : <CreateProject {...props} />;
}

function CreateProject({ onClose, onDone }: ProjectWizardProps) {
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  // Every project, archived included, since a slug stays taken. Keyed under ["projects"] so invalidating that refreshes it.
  const existing = useQuery({ queryKey: ["projects", "any"], queryFn: () => projects({ status: "any" }) });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [repos, setRepos] = useState("");
  const [aliases, setAliases] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState<string | null>(null); // null: follow the detected default
  const [purpose, setPurpose] = useState("");
  const [objectives, setObjectives] = useState("");
  const [conventions, setConventions] = useState("");
  const [guidance, setGuidance] = useState("");
  const { busy, error, go } = useDirect();
  const [shown, setShown] = useState(false); // show problems once the user tried to continue

  const parsedRepos = parseRepos(repos).repos;
  const detected = defaultCharterDomain(parsedRepos, known.data?.domains ?? []);
  const charterDomain = domain ?? detected ?? "";
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const problems = validateCreate({ name, slug: effectiveSlug, repos, aliases, description, purpose }, (existing.data?.projects ?? []).map((p) => p.slug));
  const domainNames = useMemo(() => [...(known.data?.domains.filter((d) => d.bound).map((d) => d.name) ?? []), "_global"], [known.data]);

  const payload = () => {
    const al = parseAliases(aliases).aliases;
    return {
      slug: effectiveSlug,
      name: name.trim(),
      repos: parsedRepos,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(al.length ? { aliases: al } : {}),
      charter: { ...(charterDomain ? { domain: charterDomain } : {}), body: charterBody({ purpose, objectives, conventions, guidance }) },
    };
  };

  const create = () => go(() => writeProject("create", payload()), () => {
    ["projects", "taxonomy", "list", "domains"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
    onDone?.(effectiveSlug);
    onClose();
  });

  return (
    <Modal title="New project" onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); setShown(true); if (!problems.length) create(); }}>
        <label className="field"><span>Name</span>
          <input autoFocus value={name} placeholder="Hivemind" onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Slug</span>
          <input value={effectiveSlug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          <span className="muted small">Tags the notes of the project as <code>project/{effectiveSlug || "…"}</code>.</span></label>
        <label className="field"><span>Repositories</span>
          <textarea rows={3} value={repos} placeholder={"C:/Users/you/code/app\nOne absolute path per line"} onChange={(e) => setRepos(e.target.value)} />
          <span className="muted small">Notes whose files live in these folders are matched to the project.</span></label>
        <label className="field"><span>Aliases</span>
          <input value={aliases} placeholder="Comma-separated, up to 5" onChange={(e) => setAliases(e.target.value)} /></label>
        <label className="field"><span>Description</span>
          <input value={description} maxLength={MAX_DESCRIPTION} placeholder="Optional one-liner" onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field"><span>Charter domain</span>
          <select value={charterDomain} onChange={(e) => setDomain(e.target.value)}>
            {!charterDomain && <option value="">Choose…</option>}
            {domainNames.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span className="muted small">{detected ? <>Detected from the first repository: <code>{detected}</code>.</>
            : parsedRepos.length ? "No bound domain contains the first repository; pick where the charter note lives."
            : "Add a repository to detect it, or pick where the charter note lives."}</span></label>
        <h3>Charter</h3>
        <label className="field"><span>Purpose (required)</span>
          <textarea rows={3} value={purpose} placeholder="What is this project for? One or two sentences." onChange={(e) => setPurpose(e.target.value)} /></label>
        <label className="field"><span>Objectives</span>
          <textarea rows={2} value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
        <label className="field"><span>Conventions</span>
          <textarea rows={2} value={conventions} onChange={(e) => setConventions(e.target.value)} /></label>
        <label className="field"><span>Agent guidance</span>
          <textarea rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className="muted small">Agents working in the repositories of this project read the charter, so write what they should know and follow.</span></label>
        {shown && problems.length > 0 && <div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditProject({ project, onClose, onDone }: ProjectWizardProps & { project: Project }) {
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [repos, setRepos] = useState(project.repos.join("\n"));
  const [aliases, setAliases] = useState(project.aliases.join(", "));
  const [description, setDescription] = useState(project.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const { busy, error, go } = useDirect();

  const form = { name, repos, aliases, description, status };
  const problems = validateEdit(form);
  const change = changedProject(project, form);

  const save = () => change && go(() => writeProject("update", change), () => {
    ["projects", "taxonomy", "list"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
    onDone?.(project.slug);
    onClose();
  });

  return (
    <Modal title={`Edit ${project.name}`} onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (change && !problems.length) save(); }}>
        <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Slug</span><input value={project.slug} readOnly disabled /></label>
        <label className="field"><span>Repositories</span>
          <textarea rows={3} value={repos} onChange={(e) => setRepos(e.target.value)} />
          <span className="muted small">One absolute path per line.</span></label>
        <label className="field"><span>Aliases</span><input value={aliases} placeholder="Comma-separated, up to 5" onChange={(e) => setAliases(e.target.value)} /></label>
        <label className="field"><span>Description</span><input value={description} maxLength={MAX_DESCRIPTION} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {project.status === "archived" && <option value="archived">archived</option>}
            <option value="active">active</option>
            <option value="paused">paused</option>
          </select>
          <span className="muted small">Archive a project from its dashboard.</span></label>
        <div className="field"><span>Charter</span>
          <div className="row">
            <span className="muted small">Edit the charter note directly.</span>
            {project.charter && <button type="button" className="ghost small" onClick={() => { useWorkspace.getState().openNote(project.charter!); onClose(); }}>Open charter</button>}
          </div>
        </div>
        {problems.length > 0 && <div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" type="submit" disabled={!change || problems.length > 0 || busy}>{busy ? "Saving…" : "Update project"}</button>
        </div>
      </form>
    </Modal>
  );
}
