// The project's milestones: pick one to change it, or add a new one. Opens from the project menu and from a milestone row.
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteRecord, putRecord, type Milestone, type MilestoneStatus } from "../../lib/executive";
import type { Project } from "../../lib/lm";
import { Confirm, Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";

const STATUS: Record<MilestoneStatus, string> = { planned: "Planned", at_risk: "At risk", done: "Done", missed: "Missed" };
const byDue = (a: Milestone, b: Milestone) => (a.due || "9999").localeCompare(b.due || "9999");

/** `initial` is the milestone to change, or "new" to start a blank one. */
export function MilestonesDialog({ project, milestones, initial, onClose }: { project: Project; milestones: Milestone[]; initial: Milestone | "new"; onClose: () => void }) {
  const [picked, setPicked] = useState<Milestone | "new">(initial);
  const mine = milestones.filter((m) => m.project === project.slug).sort(byDue);
  const start = picked === "new" ? undefined : mine.find((m) => m.id === picked.id) ?? picked;
  const [title, setTitle] = useState(start?.title ?? "");
  const [due, setDue] = useState(start?.due ?? "");
  const [status, setStatus] = useState<MilestoneStatus>(start?.status ?? "planned");
  const [note, setNote] = useState(start?.note ?? "");
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const pick = (m: Milestone | "new") => {
    setPicked(m);
    setTitle(m === "new" ? "" : m.title); setDue(m === "new" ? "" : m.due); setStatus(m === "new" ? "planned" : m.status); setNote(m === "new" ? "" : m.note);
  };
  const save = async () => {
    setBusy(true);
    try {
      const saved = await putRecord<Milestone>("milestone", { ...(start ?? {}), project: project.slug, title: title.trim(), due, status, note: note.trim() });
      if (start) onClose(); else pick(saved);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Milestones of ${project.name}`} onClose={onClose} locked={busy}>
      <div className="exec-form">
        <ul className="item-list">
          {mine.map((m) => (
            <li key={m.id}>
              <button className={`item-row ${start?.id === m.id ? "on" : ""}`} onClick={() => pick(m)}>
                <span className={`grow ${m.status === "done" ? "muted" : ""}`}>{m.title}</span>
                <span className="muted small">{m.due || "no date"} · {STATUS[m.status]}</span>
              </button>
            </li>
          ))}
          {!mine.length && <li className="muted small">No milestones yet.</li>}
        </ul>
        <button className="link small" onClick={() => pick("new")}><Plus size="1em" aria-hidden /> New milestone</button>
        <label className="field"><span>Name</span><input autoFocus value={title} placeholder="Public beta" onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="exec-row">
          <label className="field"><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="field"><span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as MilestoneStatus)}>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Note</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="actions">
          {start && <button onClick={() => setRemoving(true)} disabled={busy}><Trash2 size="1em" aria-hidden /> Delete</button>}
          <button onClick={onClose} disabled={busy}>Close</button>
          <button className="primary" onClick={save} disabled={busy || !title.trim()}>{start ? "Save" : "Add"}</button>
        </div>
      </div>
      {removing && start && <Confirm title="Delete this milestone?" message={`"${start.title}" is removed from Hivemind.`} action="Delete" danger
        onAnswer={(yes) => { setRemoving(false); if (yes) deleteRecord("milestone", start.id).then(onClose).catch((e) => toast(String(e), "error")); }} />}
    </Modal>
  );
}
