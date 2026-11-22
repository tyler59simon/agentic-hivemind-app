// Project health on Home: what the signals suggest or what the user set, with the reasons. Confirm writes the suggested status as
// the user's own call; Set opens the editor, where the user picks the status and says why. The user's call always wins.
import { useState } from "react";
import { deleteRecord, putRecord, type Health, type HealthStatus } from "../../lib/executive";
import { Modal } from "../../ui/Modal";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { NoteLink } from "../preview/NoteLink";
import { HEALTH_LABEL } from "../executive/health";
import { HealthChip } from "../executive/parts";
import type { ProjectRow } from "../executive/portfolio";

function HealthDialog({ row, onClose }: { row: ProjectRow; onClose: () => void }) {
  const [status, setStatus] = useState<HealthStatus>(row.health.status);
  const [note, setNote] = useState(row.health.note);
  const save = () => putRecord<Health>("health", { id: row.project.slug, project: row.project.slug, status, note: note.trim() }).then(onClose).catch((e) => toast(String(e), "error"));
  const clear = () => deleteRecord("health", row.project.slug).then(onClose).catch((e) => toast(String(e), "error"));
  return (
    <Modal title={`Health of ${row.project.name}`} onClose={onClose}>
      <div className="exec-form">
        <p className="muted small">Suggested: {HEALTH_LABEL[row.health.suggestion.status]}, because {row.health.suggestion.reasons.join("; ")}.</p>
        <div className="segmented">
          {(["green", "amber", "red"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{HEALTH_LABEL[s]}</button>)}
        </div>
        <label className="field"><span>Why (briefings quote this)</span><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="actions">
          {row.health.set && <button onClick={clear}>Go back to the suggestion</button>}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

export function HealthCard({ row }: { row: ProjectRow }) {
  const [editing, setEditing] = useState(false);
  const h = row.health;
  // Confirming turns the suggestion into the user's own call; once there is a call, Set changes it.
  const confirm = () => putRecord<Health>("health", { id: row.project.slug, project: row.project.slug, status: h.suggestion.status, note: "" }).catch((e) => toast(String(e), "error"));
  return (
    <Section title="Health" actions={<HealthChip status={h.status} suggested={!h.set} />}>
      <div className="exec-health">
        {h.note && <p>{h.note}</p>}
        <p className="muted small">{h.set && h.differs ? `The signals suggest ${HEALTH_LABEL[h.suggestion.status]}: ` : "Signals: "}{h.suggestion.reasons.join("; ")}.</p>
        <p className="small">Latest status: {row.latestStatus ? <><NoteLink row={row.latestStatus} /> <span className="muted">{row.latestStatus.updated.slice(0, 10)}</span></> : <span className="muted">none recorded</span>}</p>
        <div className="exec-row">
          {!h.set && <button onClick={confirm}>Confirm {HEALTH_LABEL[h.suggestion.status].toLowerCase()}</button>}
          <button onClick={() => setEditing(true)}>Set…</button>
        </div>
      </div>
      {editing && <HealthDialog row={row} onClose={() => setEditing(false)} />}
    </Section>
  );
}
