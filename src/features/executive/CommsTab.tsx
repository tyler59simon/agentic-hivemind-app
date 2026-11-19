// Communications: draft an email, stakeholder update, escalation or executive summary from the evidence and the user's
// writing preferences, refine it, and copy or export it. Edits the user makes to a generated draft teach Hivemind their
// style: once a draft is copied or exported, the preferences the edits show wait in the capture inbox for review.
import { Copy, Download, LoaderCircle, Plus, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { deleteRecord, draft as generate, DRAFT_KINDS, exportText, learnStyle, putRecord, refine, type Draft, type DraftKind, type ExportFormat, type Stakeholder } from "../../lib/executive";
import type { Project } from "../../lib/lm";
import { openExecutive } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Confirm } from "../../ui/Modal";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { EvidenceList, Gaps } from "./parts";
import { edited, emlText, plainText, stripCitations } from "./texts";
import { useRecords } from "./useExecutive";

const TONES = ["direct", "warm", "formal", "brief"];
const REFINES = ["Make it shorter", "Make it more formal", "Make the ask clearer and put it first", "Turn it into bullets"];
const KIND_LABEL: Record<DraftKind, string> = { email: "Email", "stakeholder update": "Stakeholder update", escalation: "Escalation", "executive summary": "Executive summary" };

function Compose({ project, projects, stakeholders, onMade }: { project?: Project; projects: Project[]; stakeholders: Stakeholder[]; onMade: (d: Draft) => void }) {
  const [kind, setKind] = useState<DraftKind>("stakeholder update");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("direct");
  const [points, setPoints] = useState("");
  const [scope, setScope] = useState(project?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const g = await generate({ kind, audience, tone, points, project: scope || null });
      const saved = await putRecord<Draft>("draft", {
        kind, channel: kind === "executive summary" ? "document" : "email", audience, tone, points, project: scope || null,
        subject: g.subject, body: stripCitations(g.body), generated: stripCitations(g.body), evidence: g.evidence, assumptions: g.assumptions, gaps: [...g.gaps, ...(g.packGaps ?? [])], versions: [],
      });
      onMade(saved);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="exec-form">
      <div className="exec-row">
        <label className="field"><span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as DraftKind)} disabled={busy}>{DRAFT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </label>
        <label className="field"><span>Tone</span>
          <select value={tone} onChange={(e) => setTone(e.target.value)} disabled={busy}>{TONES.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
        <label className="field"><span>Project</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <label className="field"><span>To</span>
        <input list="exec-stakeholders" value={audience} placeholder="VP Engineering, the platform team, a customer..." onChange={(e) => setAudience(e.target.value)} disabled={busy} />
        <datalist id="exec-stakeholders">{stakeholders.map((s) => <option key={s.id} value={s.role ? `${s.name} (${s.role})` : s.name} />)}</datalist>
      </label>
      <label className="field"><span>What it must say</span>
        <textarea rows={5} value={points} placeholder="Beta slips a week because of the provider rate limit. Ask for one more engineer until launch." onChange={(e) => setPoints(e.target.value)} disabled={busy} />
      </label>
      <p className="muted small">The draft uses what Living Memory and your records hold about the project, and the writing preferences you have accepted. Facts it lacks appear as [placeholders] and are listed beside it.</p>
      <div className="actions">
        <button className="primary" onClick={make} disabled={busy}>
          {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Drafting</> : <><Sparkles size="1em" aria-hidden /> Draft it</>}
        </button>
      </div>
    </div>
  );
}

function Editor({ d, stakeholders }: { d: Draft; stakeholders: Stakeholder[] }) {
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [preview, setPreview] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const current = useRef(d);
  current.current = d;
  // Edits are kept a moment after typing stops, and at once when the editor closes (another draft, another tab).
  const unsaved = useRef<{ subject: string; body: string } | null>(null);
  const keep = () => {
    const edit = unsaved.current;
    unsaved.current = null;
    if (edit) putRecord<Draft>("draft", { ...current.current, ...edit }).catch((e) => toast(String(e), "error"));
  };
  useEffect(() => {
    if (subject === current.current.subject && body === current.current.body) return;
    unsaved.current = { subject, body };
    const t = setTimeout(keep, 700);
    return () => clearTimeout(t);
  }, [subject, body]);
  useEffect(() => keep, []);

  // Only a draft that really left (copied, or saved to a file) teaches a preference; a cancelled export does not.
  const sent = async (how: () => Promise<boolean>) => {
    if (!(await how())) return;
    if (edited(d.generated, body) && d.learnedFrom !== d.generated) {
      await learnStyle(d.generated, body, subject).catch(() => undefined);
      await putRecord<Draft>("draft", { ...d, subject, body, learnedFrom: d.generated });
      toast("Your edits will be read for writing preferences; suggestions arrive in the capture inbox");
    }
  };
  const email = stakeholders.find((s) => d.audience.startsWith(s.name))?.email ?? "";
  const exportAs = (format: ExportFormat) => sent(() => exportText(subject || "draft", format,
    format === "eml" ? emlText(email, subject, body) : format === "txt" ? `${subject}\n\n${plainText(body)}` : `# ${subject}\n\n${body}`)
    .then((p) => { if (p) toast(`Saved ${p}`); return !!p; }, (e) => { toast(String(e), "error"); return false; }));

  const redo = async (how: string) => {
    setBusy(true);
    try {
      const g = await refine(subject, body, d.evidence, how);
      const versions = [...d.versions, { at: Date.now(), subject, body, note: how }].slice(-20);
      const next = stripCitations(g.body);
      await putRecord<Draft>("draft", { ...d, subject: g.subject, body: next, generated: next, assumptions: g.assumptions, gaps: g.gaps, versions });
      setSubject(g.subject);
      setBody(next);
      setInstruction("");
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  const restore = (i: number) => {
    const v = d.versions[i];
    setSubject(v.subject);
    setBody(v.body);
  };

  return (
    <div className="exec-draft">
      <div className="exec-form">
        <p className="muted small">{KIND_LABEL[d.kind]}{d.audience ? ` to ${d.audience}` : ""}{d.tone ? `, ${d.tone}` : ""}</p>
        <input className="exec-title" aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} />
        <div className="segmented compact">
          <button className={preview ? "" : "on"} onClick={() => setPreview(false)}>Edit</button>
          <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>Preview</button>
        </div>
        {preview ? <div className="markdown exec-preview"><Markdown>{body}</Markdown></div>
          : <textarea className="exec-body" aria-label="Body" rows={18} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />}
        <div className="exec-chips">
          {REFINES.map((r) => <button key={r} className="chip" onClick={() => redo(r)} disabled={busy}>{r}</button>)}
        </div>
        <div className="exec-row">
          <input className="grow" aria-label="How to change it" value={instruction} placeholder="Or say how to change it" disabled={busy}
            onChange={(e) => setInstruction(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && instruction.trim()) redo(instruction); }} />
          <button onClick={() => redo(instruction)} disabled={busy || !instruction.trim()}>{busy ? <LoaderCircle className="spin" size="1em" aria-hidden /> : "Revise"}</button>
        </div>
        <div className="actions">
          <button onClick={() => setConfirm(true)}><Trash2 size="1em" aria-hidden /> Delete</button>
          <button onClick={() => exportAs("md")}><Download size="1em" aria-hidden /> Markdown</button>
          <button onClick={() => exportAs("txt")}>Text</button>
          <button onClick={() => exportAs("eml")} title="An unsent email your mail program opens as a draft">Email file</button>
          <button onClick={() => sent(() => copyText(`${subject}\n\n${plainText(body)}`, "Copied as plain text"))}>Copy text</button>
          <button className="primary" onClick={() => sent(() => copyText(body, "Copied as Markdown"))}><Copy size="1em" aria-hidden /> Copy</button>
        </div>
      </div>
      <div className="exec-draft-facts">
        <Gaps gaps={d.gaps} title="Facts the draft lacks" />
        {d.assumptions.length > 0 && <Section title="Assumptions"><ul className="exec-list">{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></Section>}
        {d.versions.length > 0 && (
          <Section title="Earlier versions">
            <ul className="exec-list">
              {d.versions.map((v, i) => <li key={v.at}><button className="link small" onClick={() => restore(i)}><Undo2 size="1em" aria-hidden /> Before "{v.note}"</button></li>).reverse()}
            </ul>
          </Section>
        )}
        <Section title="Built on" count={d.evidence.length}><EvidenceList evidence={d.evidence} /></Section>
      </div>
      {confirm && <Confirm title="Delete this draft?" message="It is removed from Hivemind." action="Delete" danger
        onAnswer={(yes) => { setConfirm(false); if (yes) deleteRecord("draft", d.id).then(() => openExecutive({ tab: "comms" })).catch((e) => toast(String(e), "error")); }} />}
    </div>
  );
}

function Stakeholders({ list }: { list: Stakeholder[] }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const add = () => putRecord<Stakeholder>("stakeholder", { name: name.trim(), role: role.trim(), email: email.trim(), projects: [], notes: "" })
    .then(() => { setName(""); setRole(""); setEmail(""); }).catch((e) => toast(String(e), "error"));
  return (
    <Section title="Stakeholders" count={list.length}>
      <ul className="exec-list">
        {list.map((s) => (
          <li key={s.id} className="exec-row">
            <span className="grow">{s.name}{s.role && <span className="muted small"> · {s.role}</span>}{s.email && <span className="muted small"> · {s.email}</span>}</span>
            <button className="link small" aria-label={`Remove ${s.name}`} onClick={() => deleteRecord("stakeholder", s.id).catch((e) => toast(String(e), "error"))}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="exec-row">
        <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Role" placeholder="Role" value={role} onChange={(e) => setRole(e.target.value)} />
        <input aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button onClick={add} disabled={!name.trim()}>Add</button>
      </div>
    </Section>
  );
}

export function CommsTab({ project, projects, picked }: { project?: Project; projects: Project[]; picked?: string }) {
  const drafts = useRecords<Draft>("draft");
  const people = useRecords<Stakeholder>("stakeholder");
  const stakeholders = people.data ?? [];
  const list = drafts.data ?? [];
  const shown = picked === "new" ? undefined : list.find((d) => d.id === picked);
  return (
    <div className="exec-comms">
      <aside className="exec-drafts">
        <button className="primary" onClick={() => openExecutive({ tab: "comms", draft: "new" })}><Plus size="1em" aria-hidden /> New draft</button>
        <ul className="item-list">
          {list.map((d) => (
            <li key={d.id}>
              <button className={`item-row ${d.id === shown?.id ? "on" : ""}`} onClick={() => openExecutive({ tab: "comms", draft: d.id })}>
                <span className="grow">{d.subject || "Untitled"}<br /><span className="muted small">{KIND_LABEL[d.kind]} · {new Date(d.updated).toLocaleDateString()}</span></span>
              </button>
            </li>
          ))}
        </ul>
        <Stakeholders list={stakeholders} />
      </aside>
      <div className="exec-comms-main">
        {shown ? <Editor key={shown.id} d={shown} stakeholders={stakeholders} />
          : <Compose project={project} projects={projects} stakeholders={stakeholders} onMade={(d) => openExecutive({ tab: "comms", draft: d.id })} />}
      </div>
    </div>
  );
}
