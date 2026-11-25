import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { typeWrite, type NoteTypeDef } from "../../lib/lm";
import { typeClass, useNoteTypes } from "../../lib/noteTypes";
import { Modal } from "../../ui/Modal";
import { DirectDialog, undoToast, useDirect } from "../plans/DirectDialog";
import { DEFAULT_SUBJECT, fieldsOfType, MAX_SECTIONS, typePayload, typeProblems, type TypeFields } from "./noteTypeForm";

/** Create a custom note type, or edit one (its name stays). */
function NoteTypeForm({ def, tags, onClose }: { def?: NoteTypeDef; tags: string[]; onClose: () => void }) {
  const client = useQueryClient();
  const [f, setF] = useState<TypeFields>(() => fieldsOfType(def));
  const { busy, error, go } = useDirect();
  const problems = typeProblems(f, !def);
  const payload = typePayload(f, def);
  const set = (patch: Partial<TypeFields>) => setF((x) => ({ ...x, ...patch }));
  const setSection = (i: number, text: string) => set({ sections: f.sections.map((s, j) => (j === i ? text : s)) });
  const move = (i: number, by: number) => {
    const sections = [...f.sections];
    [sections[i], sections[i + by]] = [sections[i + by], sections[i]];
    set({ sections });
  };
  const options = (facet: string) => {
    // The default subject is the empty choice, so it is not listed a second time.
    const known = tags.filter((t) => t.startsWith(facet + "/") && t !== DEFAULT_SUBJECT);
    const current = facet === "concern" ? f.concern : f.subject;
    return current && !known.includes(current) ? [...known, current] : known;
  };
  const save = () => payload && go(() => typeWrite(def ? "update" : "create", payload), (receipt) => {
    undoToast(client, def ? `Updated note type ${def.name}.` : `Created note type ${f.name}.`, receipt);
    onClose();
  });

  return (
    <Modal title={def ? `Edit note type ${def.name}` : "New note type"} onClose={onClose} wide locked={busy}>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); if (payload && !problems.length) save(); }}>
        <label className="field"><span>Name</span>
          <input autoFocus={!def} value={f.name} readOnly={!!def} disabled={!!def} placeholder="e.g. incident" onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
          {!def && <span className="muted small">3 to 24 lowercase letters or digits. It cannot be changed later.</span>}</label>
        <label className="field"><span>Description</span>
          <input autoFocus={!!def} value={f.description} maxLength={300} placeholder="What notes of this type record" onChange={(e) => set({ description: e.target.value })} /></label>
        <label className="field"><span>Summary prompt</span>
          <input value={f.summary} maxLength={200} placeholder="optional" onChange={(e) => set({ summary: e.target.value })} />
          <span className="muted small">The first line of a new note's template: what its opening sentences should say.</span></label>
        <div className="field"><span>Sections</span>
          {f.sections.map((s, i) => (
            <div key={i} className="type-section">
              <input value={s} maxLength={40} aria-label={`Section ${i + 1}`} onChange={(e) => setSection(i, e.target.value)} />
              <button type="button" className="icon-button" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size="1.1em" aria-hidden /></button>
              <button type="button" className="icon-button" title="Move down" aria-label="Move down" disabled={i === f.sections.length - 1} onClick={() => move(i, 1)}><ChevronDown size="1.1em" aria-hidden /></button>
              <button type="button" className="icon-button" title="Remove" aria-label="Remove" onClick={() => set({ sections: f.sections.filter((_, j) => j !== i) })}><X size="1.1em" aria-hidden /></button>
            </div>
          ))}
          <div className="row-line">
            <button type="button" className="ghost small" disabled={f.sections.length >= MAX_SECTIONS} onClick={() => set({ sections: [...f.sections, ""] })}>Add section</button>
            <span className="muted small">Headings a new note starts with, in order. Without any, it gets Details.</span>
          </div>
        </div>
        <label className="field"><span>Review every (days)</span>
          <input type="number" value={f.reviewDays} placeholder="none" onChange={(e) => set({ reviewDays: e.target.value })} /></label>
        <label className="field"><span>Default concern</span>
          <select value={f.concern} onChange={(e) => set({ concern: e.target.value })}>
            <option value="">none</option>
            {options("concern").map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
        <label className="field"><span>Default subject</span>
          <select value={f.subject} onChange={(e) => set({ subject: e.target.value })}>
            <option value="">{DEFAULT_SUBJECT} (default)</option>
            {options("subject").map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
        <label className="check"><input type="checkbox" checked={f.actions} onChange={(e) => set({ actions: e.target.checked })} /> Notes have Action items (and can be resolved)</label>
        {problems.length > 0 && <div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {error && <div className="banner error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" type="submit" disabled={!payload || problems.length > 0 || busy}>{busy ? "Saving…" : def ? "Update type" : "Create type"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Note types: the built-ins, read-only, and the store's own, which can be created, edited, retired and reactivated. */
export function NoteTypesSection({ tags }: { tags: string[] }) {
  const types = useNoteTypes();
  const [editing, setEditing] = useState<NoteTypeDef | "new" | null>(null);
  const [changing, setChanging] = useState<NoteTypeDef | null>(null);
  const builtin = types.all.filter((t) => t.builtin);
  const custom = types.all.filter((t) => !t.builtin);
  const row = (t: NoteTypeDef) => (
    <li key={t.name} className="tag-row">
      <span className="link-row" title={t.description}>
        <span className={`badge ${typeClass(t.name)}`}>{t.name}</span> <span className="muted small">{t.status === "retired" ? "retired · " : ""}{t.description}</span>
      </span>
      {!t.builtin && <button className="ghost small" onClick={() => setEditing(t)}>Edit…</button>}
      {!t.builtin && <button className="ghost small" onClick={() => setChanging(t)}>{t.status === "retired" ? "Reactivate…" : "Retire…"}</button>}
    </li>
  );

  return (
    <section className="facet">
      <h2 className="settings-h2">Note types <span className="muted small">{types.all.length}</span></h2>
      <p className="muted small">Living Memory's own types cannot be changed. Retiring a custom type keeps its notes; new notes can no longer use it.</p>
      <ul className="tag-list">{builtin.map(row)}</ul>
      {custom.length ? <ul className="tag-list">{custom.map(row)}</ul> : <p className="muted small">No custom types yet.</p>}
      <div className="row-line"><button onClick={() => setEditing("new")}>New type…</button></div>
      {editing && <NoteTypeForm def={editing === "new" ? undefined : editing} tags={tags} onClose={() => setEditing(null)} />}
      {changing && (changing.status === "retired"
        ? <DirectDialog title={`Reactivate ${changing.name}`} applyLabel="Reactivate"
            intro={<p>New notes can use the type {changing.name} again.</p>}
            run={() => typeWrite("update", { name: changing.name, status: "active" })} done={`Reactivated note type ${changing.name}.`}
            onClose={() => setChanging(null)} />
        : <DirectDialog title={`Retire ${changing.name}`} applyLabel="Retire" danger
            intro={<p>Notes of type {changing.name} keep it, but new notes and type changes can no longer use it.</p>}
            run={() => typeWrite("retire", { name: changing.name })} done={`Retired note type ${changing.name}.`}
            onClose={() => setChanging(null)} />)}
    </section>
  );
}
