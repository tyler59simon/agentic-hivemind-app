import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { domains, projectPlan, projects, type Project, type ProjectStatus } from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import {
  changedProject, charterBody, defaultCharterDomain, parseAliases, parseRepos, slugify, validateCreate, validateEdit,
  MAX_DESCRIPTION,
} from "./wizard";

export interface ProjectWizardProps {
  /** "create" makes a project (registry entry, project/<slug> tag and charter note in one plan); "edit" updates the registry entry. */
  mode: "create" | "edit";
  /** The project being edited (mode "edit"). */
  project?: Project;
  onClose: () => void;
  /** Called after the plan was applied, with the project's slug. */
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
  const [review, setReview] = useState(false);
  const applied = useRef(false); // PlanDialog closes after apply and on cancel: cancel returns to the form
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

  if (review) {
    return (
      <PlanDialog
        title={`Create project ${name.trim()}`}
        intro={<p>One plan adds the <code>project/{effectiveSlug}</code> tag, registers the project and creates its charter note. One undo from History reverses all three.</p>}
        make={() => projectPlan("create", payload())}
        applyLabel="Create project"
        onApplied={() => {
          applied.current = true;
          ["projects", "taxonomy", "list", "domains"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
          onDone?.(effectiveSlug);
        }}
        onClose={() => (applied.current ? onClose() : setReview(false))}
      />
    );
  }

  return (
    <Modal title="New project" onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); setShown(true); if (!problems.length) setReview(true); }}>
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
          <span className="muted small">{detected ? <>Detected from the first repository: <code>{detected}</code>.</> : "No bound domain contains the first repository; pick where the charter note lives."}</span></label>
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
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Review plan…</button>
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
  const [review, setReview] = useState(false);
  const applied = useRef(false); // PlanDialog closes after apply and on cancel: cancel returns to the form

  const form = { name, repos, aliases, description, status };
  const problems = validateEdit(form);
  const change = changedProject(project, form);

  if (review && change) {
    return (
      <PlanDialog
        title={`Update project ${project.name}`}
        intro={<p>This changes the registry entry of the project only.</p>}
        make={() => projectPlan("update", change)}
        applyLabel="Update project"
        onApplied={() => {
          applied.current = true;
          ["projects", "taxonomy", "list"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
          onDone?.(project.slug);
        }}
        onClose={() => (applied.current ? onClose() : setReview(false))}
      />
    );
  }

  return (
    <Modal title={`Edit ${project.name}`} onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (change && !problems.length) setReview(true); }}>
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
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={!change || problems.length > 0}>Review plan…</button>
        </div>
      </form>
    </Modal>
  );
}
