import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { systemArchitecture } from "../../lib/architecture";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { changePlan, STAGES, type ChangePlan, type ChangeStage } from "../../lib/lm";
import { useApp } from "../../store";
import { Modal } from "../../ui/Modal";
import { repoName } from "../agents/session";
import { PlanDialog } from "../plans/PlanDialog";
import { systemsForProject } from "../projects/scope";
import { projectsQuery } from "../projects/useProject";
import { ownContainers } from "../systems/diagram";
import { systemsQuery } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { displayId, STAGE_LABELS } from "./changes";
import { useChangeIntent, type ChangeForm } from "./intent";
import { changedChange, createPayload, EMPTY, formOf, MAX_TITLE, validateChange, type ChangeFields } from "./wizard";

/** The change form for the current intent, mounted once in the shell. */
export function ChangeWizardHost() {
  const enabled = useChangesEnabled();
  const form = useChangeIntent((s) => s.form);
  const close = useChangeIntent((s) => s.close);
  if (!enabled || !form) return null;
  const key = form.mode + ("change" in form ? form.change.id : "ref" in form ? form.ref : "");
  return <ChangeWizard key={key} form={form} onClose={close} />;
}

function ChangeWizard({ form, onClose }: { form: ChangeForm; onClose: () => void }) {
  const go = useApp((s) => s.go);
  const picked = useApp((s) => s.project);
  const systemsOn = useSystemsEnabled();
  const registry = useQuery(projectsQuery());
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const note = useQuery({ ...noteQuery(form.mode === "adopt" ? form.ref : ""), enabled: form.mode === "adopt" });
  const projects = (registry.data?.projects ?? []).filter((p) => p.status === "active");
  const [fields, setFields] = useState<ChangeFields>(() => {
    if (form.mode === "edit") return formOf(form.change);
    const p = projects.find((x) => x.slug === picked);
    const base = { ...EMPTY, project: p?.slug ?? "", repo: p?.repos[0] ?? "" };
    return form.mode === "adopt" ? { ...base, title: form.title } : base;
  });
  const [review, setReview] = useState(false);
  const applied = useRef(false); // PlanDialog closes after apply and on cancel: cancel returns to the form
  const made = useRef<number | null>(null); // the id from the plan summary; final only once applied
  const [shown, setShown] = useState(false); // show problems once the user tried to continue
  const set = (patch: Partial<ChangeFields>) => setFields((f) => ({ ...f, ...patch }));

  // The projects load after the form opens: preselect the picked one, or for an adopted note the project its tag names.
  useEffect(() => {
    if (form.mode === "edit" || fields.project) return;
    const p = projects.find((x) => x.slug === picked) ?? (form.mode === "adopt" ? projects.find((x) => note.data?.tags.includes(x.tag)) : undefined);
    if (p) set({ project: p.slug, repo: p.repos[0] ?? "" });
  }, [registry.data, note.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const project = projects.find((p) => p.slug === fields.project);
  const live = (systems.data?.systems ?? []).filter((s) => s.status !== "retired");
  const near = project ? systemsForProject(project, live) : [];
  const system = live.find((s) => s.slug === fields.system);
  const arch = useQuery({
    queryKey: ["architecture", system?.slug, system?.architecture ?? null], queryFn: () => systemArchitecture(system!.slug),
    enabled: !!system, staleTime: 60_000, retry: false,
  });
  const elements = ownContainers(arch.data?.model ?? null);
  const problems = validateChange(fields, form.mode);
  const update = form.mode === "edit" ? changedChange(form.change, fields) : null;
  const keep = (p: ChangePlan) => { made.current = p.summary.id; return p; };

  if (review) {
    const dialog = {
      create: {
        title: `Start change: ${fields.title.trim()}`, applyLabel: "Start change", make: () => changePlan("create", createPayload(fields)).then(keep),
        intro: "One plan gives the change the next free number, registers it and creates its brief (a plan note). One undo from History reverses both, as long as neither was edited since.",
      },
      adopt: {
        title: `Adopt “${form.mode === "adopt" ? form.title : ""}” as a change`, applyLabel: "Adopt as change",
        make: () => changePlan("create", createPayload(fields, form.mode === "adopt" ? form.ref : undefined)).then(keep),
        intro: "One plan gives the change the next free number and registers it with this note as its brief. The note keeps its title and text; it gains the project tag if it lacks it.",
      },
      edit: {
        title: `Update ${form.mode === "edit" ? displayId(form.change.id) : ""}`, applyLabel: "Update change",
        make: () => changePlan("update", update!), intro: "This changes the registry entry of the change only.",
      },
    }[form.mode];
    return (
      <PlanDialog
        title={dialog.title} intro={<p>{dialog.intro}</p>} make={dialog.make} applyLabel={dialog.applyLabel}
        onApplied={() => {
          applied.current = true;
          if (form.mode !== "edit") go({ page: "changes", id: made.current!, view: "detail" });
        }}
        onClose={() => (applied.current ? onClose() : setReview(false))}
      />
    );
  }

  const edit = form.mode === "edit";
  const title = form.mode === "create" ? "Start a change" : form.mode === "adopt" ? "Adopt as change" : `Edit ${displayId(form.change.id)}`;
  return (
    <Modal title={title} onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => {
        e.preventDefault(); setShown(true);
        if (!problems.length && (!edit || update)) setReview(true);
      }}>
        {form.mode === "adopt" && <p className="muted">Brief: {form.title}</p>}
        <label className="field"><span>Project</span>
          <select name="project" value={fields.project} disabled={edit}
            onChange={(e) => set({ project: e.target.value, repo: projects.find((p) => p.slug === e.target.value)?.repos[0] ?? "", system: "", element: "" })}>
            {!fields.project && <option value="">Choose…</option>}
            {edit && !project && <option value={fields.project}>{fields.project}</option>}
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select></label>
        <label className="field"><span>Title</span>
          <input name="title" autoFocus maxLength={MAX_TITLE} value={fields.title} placeholder="Prevent duplicate payment alerts"
            onChange={(e) => set({ title: e.target.value })} /></label>
        {form.mode === "create" && (
          <label className="field"><span>Outcome</span>
            <textarea name="outcome" rows={3} value={fields.outcome} placeholder="What will be true when this is done? One or two sentences."
              onChange={(e) => set({ outcome: e.target.value })} />
            <span className="muted small">Becomes the Executive Summary of the brief.</span></label>
        )}
        {form.mode !== "create" && (
          <label className="field"><span>Stage</span>
            <select name="stage" value={fields.stage} onChange={(e) => set({ stage: e.target.value as ChangeStage })}>
              {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
            {edit && <span className="muted small">Moving back a stage is done here; the stepper only moves forward.</span>}</label>
        )}
        {project && !project.repos.length && !edit ? (
          <p className="muted small">This project has no repositories. A session for this change will ask for one.</p>
        ) : (
          <label className="field"><span>Repository</span>
            <select name="repo" value={fields.repo} onChange={(e) => set({ repo: e.target.value })}>
              {(edit || !project) && <option value="">None</option>}
              {edit && fields.repo && !project?.repos.includes(fields.repo) && <option value={fields.repo}>{repoName(fields.repo)}</option>}
              {(project?.repos ?? []).map((r) => <option key={r} value={r} title={r}>{repoName(r)}</option>)}
            </select></label>
        )}
        <label className="field"><span>Branch</span>
          <input name="branch" value={fields.branch} placeholder="feature/idempotency" onChange={(e) => set({ branch: e.target.value })} />
          <span className="muted small">The branch agent sessions for this change start from. Leave empty for the repository's current branch.</span></label>
        {systemsOn && (
          <>
            <label className="field"><span>System</span>
              <select name="system" value={fields.system} onChange={(e) => set({ system: e.target.value, element: "" })}>
                <option value="">None</option>
                {[...near, ...live.filter((s) => !near.includes(s))].map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                {fields.system && !system && <option value={fields.system}>{fields.system}</option>}
              </select></label>
            <label className="field"><span>Element</span>
              <select name="element" value={fields.element} disabled={!elements.length} onChange={(e) => set({ element: e.target.value })}>
                <option value="">None</option>
                {elements.map((el) => <option key={el.id} value={el.name}>{el.name}</option>)}
                {fields.element && !elements.some((el) => el.name === fields.element) && <option value={fields.element}>{fields.element}</option>}
              </select>
              {!elements.length && <span className="muted small">Pick a system that has an architecture model to choose an element.</span>}</label>
          </>
        )}
        {shown && problems.length > 0 && <div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={edit && (!update || problems.length > 0)}>Review plan…</button>
        </div>
      </form>
    </Modal>
  );
}
