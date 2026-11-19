// The portfolio: every project's health, next milestone, commitments and risks; or one project in depth, where the user
// sets health, keeps milestones and ticks or adds commitments. Every change here is one the user makes on purpose.
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteRecord, putRecord, type Health, type HealthStatus, type Milestone, type MilestoneStatus } from "../../lib/executive";
import { check, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { openExecutive, useApp } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { NoteLink } from "../preview/NoteLink";
import { perform, useWriteContext } from "./Capture";
import { planWrite } from "./items";
import type { CommitmentRow } from "./commitments";
import { HEALTH_LABEL } from "./health";
import { HealthChip } from "./parts";
import type { ProjectRow } from "./portfolio";

const MILESTONE_STATUS: Record<MilestoneStatus, string> = { planned: "Planned", at_risk: "At risk", done: "Done", missed: "Missed" };
const TIMING_CHIP = { overdue: "bad", soon: "warn", later: "", undated: "" } as const;

export function CommitmentList({ items, empty = "No open commitments." }: { items: (CommitmentRow & { project?: Project })[]; empty?: string }) {
  const client = useQueryClient();
  const tick = async (c: CommitmentRow, done: boolean) => {
    try {
      const r = await check(c.ref, c.index, done);
      recordOperation(r.operation_id);
      await refreshStore(client);
      if (done) toast(`Done: ${c.task}`, "info", { label: "Undo", run: () => tick(c, false) });
    } catch (e) { toast(String(e), "error"); }
  };
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <ul className="exec-list">
      {items.map((c) => (
        <li key={`${c.ref}#${c.index}`} className="exec-commitment">
          <input type="checkbox" aria-label={`Mark done: ${c.task}`} onChange={() => tick(c, true)} />
          <span className="grow">
            {c.task}
            <span className="muted small">{[c.owner && ` · ${c.owner}`, c.project && ` · ${c.project.name}`].filter(Boolean).join("")}</span>
          </span>
          {c.due && <span className={`status-chip ${TIMING_CHIP[c.timing]}`}>{c.timing === "overdue" ? "overdue " : "due "}{c.due}</span>}
        </li>
      ))}
    </ul>
  );
}

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

function Milestones({ row }: { row: ProjectRow }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [removing, setRemoving] = useState<Milestone | null>(null);
  const save = (m: Partial<Milestone>) => putRecord<Milestone>("milestone", m).catch((e) => toast(String(e), "error"));
  const add = () => save({ project: row.project.slug, title: title.trim(), due, status: "planned", note: "" }).then(() => { setTitle(""); setDue(""); });
  return (
    <Section title="Milestones" count={row.milestones.length}>
      <ul className="exec-list">
        {row.milestones.map((m) => (
          <li key={m.id} className="exec-row">
            <span className={`grow ${m.status === "done" ? "muted" : ""}`}>{m.title}</span>
            <input type="date" aria-label={`Due date of ${m.title}`} value={m.due} onChange={(e) => save({ ...m, due: e.target.value })} />
            <select aria-label={`Status of ${m.title}`} value={m.status} onChange={(e) => save({ ...m, status: e.target.value as MilestoneStatus })}>
              {Object.entries(MILESTONE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="icon" aria-label={`Delete ${m.title}`} onClick={() => setRemoving(m)}><Trash2 size="1em" aria-hidden /></button>
          </li>
        ))}
      </ul>
      <div className="exec-row">
        <input className="grow" aria-label="New milestone" placeholder="New milestone" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button onClick={add} disabled={!title.trim()}><Plus size="1em" aria-hidden /> Add</button>
      </div>
      {removing && <Confirm title="Delete this milestone?" message={`"${removing.title}" is removed from Hivemind.`} action="Delete" danger
        onAnswer={(yes) => { const m = removing; setRemoving(null); if (yes) deleteRecord("milestone", m.id).catch((e) => toast(String(e), "error")); }} />}
    </Section>
  );
}

function AddCommitment({ project, projects }: { project: Project; projects: Project[] }) {
  const client = useQueryClient();
  const ctx = useWriteContext(projects, "Executive portfolio");
  const [task, setTask] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const item = { id: "new", kind: "commitment" as const, project: project.slug, title: task, summary: "", details: [], owner, due, quote: "", confidence: "high" as const, similar: [], state: "pending" as const };
      await perform(planWrite(item, ctx));
      await refreshStore(client);
      setTask(""); setOwner(""); setDue("");
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="exec-row">
      <input className="grow" aria-label="New commitment" placeholder="New commitment" value={task} onChange={(e) => setTask(e.target.value)} disabled={busy} />
      <input aria-label="Owner" placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={busy} />
      <input type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} disabled={busy} />
      <button onClick={add} disabled={busy || !task.trim() || !ctx.ready}><Plus size="1em" aria-hidden /> Add</button>
    </div>
  );
}

function ProjectDetail({ row, projects }: { row: ProjectRow; projects: Project[] }) {
  const [editing, setEditing] = useState(false);
  const h = row.health;
  return (
    <Split rail={
      <>
        <Section title="Risks and open bugs" count={row.risks.length} empty={row.risks.length ? undefined : "None open."}>
          <ul className="exec-list">{row.risks.map((r) => <li key={r.ref}><NoteLink row={r} />{r.summary && <div className="muted small">{r.summary}</div>}</li>)}</ul>
        </Section>
        <Section title="Recent decisions" count={row.decisions.length} empty={row.decisions.length ? undefined : "None recorded."}>
          <ul className="exec-list">{row.decisions.slice(0, 8).map((r) => <li key={r.ref}><NoteLink row={r} /> <span className="muted small">{r.updated.slice(0, 10)}</span></li>)}</ul>
        </Section>
      </>
    }>
      <Section title="Health" actions={<button onClick={() => setEditing(true)}>Set health</button>}>
        <div className="exec-health">
          <HealthChip status={h.status} suggested={!h.set} />
          {h.note && <p>{h.note}</p>}
          <p className="muted small">{h.set && h.differs ? `The signals suggest ${HEALTH_LABEL[h.suggestion.status]}: ` : "Signals: "}{h.suggestion.reasons.join("; ")}.</p>
          <p className="small">Latest status: {row.latestStatus ? <><NoteLink row={row.latestStatus} /> <span className="muted">{row.latestStatus.updated.slice(0, 10)}</span></> : <span className="muted">none recorded</span>}</p>
        </div>
      </Section>
      <Milestones row={row} />
      <Section title="Commitments" count={row.commitments.length}>
        <CommitmentList items={row.commitments} />
        <AddCommitment project={row.project} projects={projects} />
      </Section>
      <div className="actions">
        <button onClick={() => openExecutive({ tab: "comms", draft: "new" })}>Draft an update</button>
        <button onClick={() => openExecutive({ tab: "briefings" })}>Brief me on it</button>
      </div>
      {editing && <HealthDialog row={row} onClose={() => setEditing(false)} />}
    </Split>
  );
}

export function PortfolioTab({ rows, projects, project, loading, error }: { rows: ProjectRow[]; projects: Project[]; project?: Project; loading: boolean; error: unknown }) {
  const setProject = useApp((s) => s.setProject);
  if (project && rows[0]) return <ProjectDetail row={rows[0]} projects={projects} />;
  return (
    <Section loading={loading} error={error} empty={rows.length ? undefined : "No projects yet. Create one from Overview."}>
      <table className="exec-table">
        <thead><tr><th>Project</th><th>Health</th><th>Next milestone</th><th>Commitments</th><th>Risks</th><th>Latest status</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const overdue = r.commitments.filter((c) => c.timing === "overdue").length;
            return (
              <tr key={r.project.slug} onClick={() => setProject(r.project.slug)} title={`Open ${r.project.name}`}>
                <td><strong>{r.project.name}</strong>{r.project.status === "paused" && <span className="muted small"> paused</span>}</td>
                <td><HealthChip status={r.health.status} suggested={!r.health.set} /><div className="muted small">{r.health.suggestion.reasons[0]}</div></td>
                <td>{r.next ? <>{r.next.title}<div className="muted small">{r.next.due || "no date"}</div></> : <span className="muted">none</span>}</td>
                <td>{r.commitments.length} open{overdue > 0 && <span className="status-chip bad">{overdue} overdue</span>}</td>
                <td>{r.risks.length}</td>
                <td>{r.latestStatus ? r.latestStatus.updated.slice(0, 10) : <span className="muted">none</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
