import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { domains, systemPlan, systems, type System, type SystemStatus } from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { defaultCharterDomain, MAX_DESCRIPTION, parseRepos, slugify } from "../projects/wizard";
import { changedSystem, formFields, formOf, passportBody, validateSystem, type SystemForm } from "./wizard";

export interface SystemWizardProps {
  /** "create" makes a system (registry entry, system/<slug> tag and passport note in one plan); "edit" updates the registry entry. */
  mode: "create" | "edit";
  /** The system being edited (mode "edit"). */
  system?: System;
  onClose: () => void;
  /** Called after the plan was applied. */
  onDone?: (slug: string, name: string) => void;
}

export function SystemWizard(props: SystemWizardProps) {
  return props.mode === "edit" && props.system ? <EditSystem {...props} system={props.system} /> : <CreateSystem {...props} />;
}

const EMPTY: SystemForm = { name: "", purpose: "", owners: "", capabilities: "", repos: "", dependsOn: [], architecture: "", status: "active" };

/** The registry fields both forms share. */
function Fields({ form, set, others }: { form: SystemForm; set: (patch: Partial<SystemForm>) => void; others: System[] }) {
  const toggle = (slug: string, on: boolean) => set({ dependsOn: on ? [...form.dependsOn, slug] : form.dependsOn.filter((s) => s !== slug) });
  return (
    <>
      <label className="field"><span>Purpose</span>
        <textarea rows={2} value={form.purpose} maxLength={MAX_DESCRIPTION} placeholder="What is this system for? One or two sentences." onChange={(e) => set({ purpose: e.target.value })} /></label>
      <label className="field"><span>Capabilities</span>
        <textarea rows={3} value={form.capabilities} placeholder={"Take payments\nIssue invoices\nOne business capability per line"} onChange={(e) => set({ capabilities: e.target.value })} /></label>
      <label className="field"><span>Owners</span>
        <input value={form.owners} placeholder="Teams or people, comma-separated" onChange={(e) => set({ owners: e.target.value })} /></label>
      <label className="field"><span>Repositories</span>
        <textarea rows={2} value={form.repos} placeholder={"C:/Users/you/code/service\nOne absolute path per line; leave empty for a system you do not own"} onChange={(e) => set({ repos: e.target.value })} />
        <span className="muted small">Notes whose files live in these folders are tagged with the system.</span></label>
      <label className="field"><span>Architecture folder</span>
        <input value={form.architecture} placeholder="C:/Users/you/architecture/service" onChange={(e) => set({ architecture: e.target.value })} />
        <span className="muted small">Where Architecture Suite output for this system lives, outside the repositories. The passport reads its diagrams and model from here.</span></label>
      <div className="field"><span>Depends on</span>
        {others.length ? (
          <div className="chips">
            {others.map((o) => (
              <label key={o.slug} className="check small">
                <input type="checkbox" checked={form.dependsOn.includes(o.slug)} onChange={(e) => toggle(o.slug, e.target.checked)} /> {o.name}
              </label>
            ))}
          </div>
        ) : <span className="muted small">No other systems are registered yet. Register the systems this one calls, then edit it to link them.</span>}
      </div>
    </>
  );
}

function CreateSystem({ onClose, onDone }: SystemWizardProps) {
  const client = useQueryClient();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  // Every system, retired included, since a slug stays taken. Keyed under ["systems"] so invalidating that refreshes it.
  const existing = useQuery({ queryKey: ["systems", "any"], queryFn: () => systems({ status: "any" }) });
  const [form, setForm] = useState<SystemForm>(EMPTY);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [domain, setDomain] = useState<string | null>(null); // null: follow the detected default
  const [boundaries, setBoundaries] = useState("");
  const [operations, setOperations] = useState("");
  const [guidance, setGuidance] = useState("");
  const [review, setReview] = useState(false);
  const [shown, setShown] = useState(false); // show problems once the user tried to continue
  const applied = useRef(false); // PlanDialog closes after apply and on cancel: cancel returns to the form

  const all = existing.data?.systems ?? [];
  const effectiveSlug = slugTouched ? slug : slugify(form.name);
  const detected = defaultCharterDomain(parseRepos(form.repos).repos, known.data?.domains ?? []);
  const passportDomain = domain ?? detected ?? "_global";
  const problems = validateSystem(form, { slug: effectiveSlug, existingSlugs: all.map((s) => s.slug) });
  const domainNames = useMemo(() => [...(known.data?.domains.filter((d) => d.bound).map((d) => d.name) ?? []), "_global"], [known.data]);

  const payload = () => ({
    slug: effectiveSlug,
    ...formFields(form),
    passport: { domain: passportDomain, body: passportBody({ purpose: form.purpose, boundaries, operations, guidance }) },
  });

  if (review) {
    return (
      <PlanDialog
        title={`Create system ${form.name.trim()}`}
        intro={<p>One plan adds the <code>system/{effectiveSlug}</code> tag, registers the system and creates its passport note. One undo from History reverses all three.</p>}
        make={() => systemPlan("create", payload())}
        applyLabel="Create system"
        onApplied={() => {
          applied.current = true;
          ["systems", "taxonomy", "list", "domains"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
          onDone?.(effectiveSlug, form.name.trim());
        }}
        onClose={() => (applied.current ? onClose() : setReview(false))}
      />
    );
  }

  return (
    <Modal title="New system" onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); setShown(true); if (!problems.length) setReview(true); }}>
        <label className="field"><span>Name</span>
          <input autoFocus value={form.name} placeholder="Billing" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Slug</span>
          <input value={effectiveSlug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
          <span className="muted small">Tags the notes of the system as <code>system/{effectiveSlug || "…"}</code>.</span></label>
        <Fields form={form} set={(patch) => setForm({ ...form, ...patch })} others={all.filter((s) => s.status !== "retired")} />
        <h3>Passport note</h3>
        <label className="field"><span>Domain</span>
          <select value={passportDomain} onChange={(e) => setDomain(e.target.value)}>
            {domainNames.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span className="muted small">{detected ? <>Detected from the first repository: <code>{detected}</code>.</> : "No bound domain contains a repository of this system, so the note goes to the global domain unless you pick another."}</span></label>
        <label className="field"><span>Boundaries</span>
          <textarea rows={2} value={boundaries} placeholder="What is inside this system, and what is not" onChange={(e) => setBoundaries(e.target.value)} /></label>
        <label className="field"><span>Operations</span>
          <textarea rows={2} value={operations} placeholder="Where it runs, how it is deployed, who is on call" onChange={(e) => setOperations(e.target.value)} /></label>
        <label className="field"><span>Agent guidance</span>
          <textarea rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <span className="muted small">The purpose above becomes the note's summary. Agents working on the system read this note.</span></label>
        {shown && problems.length > 0 && <div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Review plan…</button>
        </div>
      </form>
    </Modal>
  );
}

function EditSystem({ system, onClose, onDone }: SystemWizardProps & { system: System }) {
  const client = useQueryClient();
  const existing = useQuery({ queryKey: ["systems", "any"], queryFn: () => systems({ status: "any" }) });
  const [form, setForm] = useState<SystemForm>(() => formOf(system));
  const [review, setReview] = useState(false);
  const applied = useRef(false); // PlanDialog closes after apply and on cancel: cancel returns to the form

  const problems = validateSystem(form);
  const change = changedSystem(system, form);
  // A dependency that was since retired stays listed so it can be unticked.
  const others = (existing.data?.systems ?? []).filter((s) => s.slug !== system.slug && (s.status !== "retired" || form.dependsOn.includes(s.slug)));

  if (review && change) {
    return (
      <PlanDialog
        title={`Update system ${system.name}`}
        intro={<p>This changes the registry entry of the system only.</p>}
        make={() => systemPlan("update", change)}
        applyLabel="Update system"
        onApplied={() => {
          applied.current = true;
          ["systems", "list", "architecture"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
          onDone?.(system.slug, form.name.trim());
        }}
        onClose={() => (applied.current ? onClose() : setReview(false))}
      />
    );
  }

  return (
    <Modal title={`Edit ${system.name}`} onClose={onClose} wide>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (change && !problems.length) setReview(true); }}>
        <label className="field"><span>Name</span><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Slug</span><input value={system.slug} readOnly disabled /></label>
        <Fields form={form} set={(patch) => setForm({ ...form, ...patch })} others={others} />
        <label className="field"><span>Status</span>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SystemStatus })}>
            <option value="active">active</option>
            <option value="deprecated">deprecated</option>
            <option value="retired">retired</option>
          </select>
          <span className="muted small">Only active systems are matched to new notes by repository.</span></label>
        <div className="field"><span>Passport note</span>
          <div className="row">
            <span className="muted small">Edit the passport note directly.</span>
            {system.passport && <button type="button" className="ghost small" onClick={() => { useWorkspace.getState().openNote(system.passport!); onClose(); }}>Open passport note</button>}
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
