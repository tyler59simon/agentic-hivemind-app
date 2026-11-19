// Quick capture (paste anything, Hivemind extracts what is worth keeping) and the review of a capture batch. Nothing reaches
// Living Memory or an existing record until the user accepts an item; replacing an existing note asks once more.
import { useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { classify } from "../../lib/errors";
import { extract, ITEM_KINDS, putRecord, type CaptureBatch, type CaptureItem, type ItemKind, type Milestone } from "../../lib/executive";
import { addAction, capture, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { openExecutive } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { NoteLink } from "../preview/NoteLink";
import { blocked, KIND_LABEL, pendingItems, planWrite, replaceable, type Context, type Write } from "./items";
import { isoToday } from "./commitments";
import { useNotes, useRecords, useStoreFacts } from "./useExecutive";

const KEPT_KEY = "hivemind.executive.capture";
const kept = () => { try { return localStorage.getItem(KEPT_KEY) ?? ""; } catch { return ""; } };
const keep = (text: string) => { try { localStorage.setItem(KEPT_KEY, text); } catch { /* not kept */ } };

/** The universal input: meeting notes, a conversation, a document, loose thoughts. */
export function CaptureDialog({ projects, project, onClose }: { projects: Project[]; project?: Project; onClose: () => void }) {
  const [text, setText] = useState(kept);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState(project?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const batch = await extract(text, scope || null, label.trim() || undefined);
      keep("");
      onClose();
      if (!batch) toast("Nothing worth keeping was found in that text.");
      else openExecutive({ capture: batch.id });
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Capture" onClose={onClose} wide locked={busy}>
      <div className="exec-form" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) { e.preventDefault(); run(); } }}>
        <p className="muted small">Paste meeting notes, a conversation or a document, or type what is on your mind. Hivemind pulls out decisions, commitments, risks, status, milestones and facts worth keeping. You review each one before anything is saved.</p>
        <textarea className="exec-capture-text" autoFocus rows={14} value={text} placeholder="Notes from the platform sync: we agreed to..." disabled={busy}
          onChange={(e) => { setText(e.target.value); keep(e.target.value); }} />
        <div className="exec-row">
          <label className="field grow"><span>Where it is from</span><input value={label} placeholder="Platform sync, 19 Nov" onChange={(e) => setLabel(e.target.value)} disabled={busy} /></label>
          <label className="field"><span>Project</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
              <option value="">Decide per item</option>
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={run} disabled={busy || !text.trim()} title="Ctrl+Enter">
            {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Reading</> : <><Sparkles size="1em" aria-hidden /> Extract</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What planning a write needs from the store. Items with no project go to the first project's domain. */
export function useWriteContext(projects: Project[], sourceLabel: string): Context & { ready: boolean } {
  const { rows } = useNotes();
  const facts = useStoreFacts();
  return {
    projects, known: facts.known, rows: rows.data?.notes ?? [], defaultDomain: projects[0]?.charter?.split(":")[0] || facts.defaultDomain,
    globalDomain: facts.globalDomain, sourceLabel, today: isoToday(),
    // Planning before the notes arrive would miss an existing commitments note and start a second one.
    ready: rows.isSuccess && facts.ready,
  };
}

/** Run one planned write. Returns what was written: a note ref or `milestone:<id>`, and the operation. */
export async function perform(write: Write, anyway?: boolean): Promise<{ ref: string; operation?: string }> {
  if (write.kind === "milestone") return { ref: `milestone:${(await putRecord<Milestone>("milestone", write.record)).id}` };
  const r = write.kind === "action" ? await addAction(write.ref, write.text) : await capture(write.domain, anyway ? { ...write.payload, allow_similar: true } : write.payload);
  recordOperation(r.operation_id);
  return { ref: write.kind === "action" ? write.ref : `${r.domain ?? write.domain}:${r.id}`, operation: r.operation_id };
}

type Choice = "new" | string;

function ItemCard({ item, projects, ctx, onChange, onAccept, onReject, busy, problem }: {
  item: CaptureItem; projects: Project[]; ctx: Context & { ready: boolean }; busy: boolean; problem?: string;
  onChange: (next: CaptureItem) => void; onAccept: (replace?: string, anyway?: boolean) => void; onReject: () => void;
}) {
  const [picked, setChoice] = useState<Choice>("new");
  // Only a note the item would really replace: same domain, a note kind. A changed kind or project drops a stale choice.
  const noteMatches = item.similar.filter((s) => !s.ref.startsWith("milestone:") && replaceable(item, s.ref, ctx));
  const choice = noteMatches.some((s) => s.ref === picked) ? picked : "new";
  const why = blocked(item);
  const set = (patch: Partial<CaptureItem>) => onChange({ ...item, ...patch });
  const dated = item.kind === "commitment" || item.kind === "milestone";
  const done = item.state !== "pending";
  return (
    <article className={`exec-item ${done ? `done ${item.state}` : ""}`}>
      <div className="exec-row">
        <select aria-label="Kind" value={item.kind} disabled={done} onChange={(e) => set({ kind: e.target.value as ItemKind })}>
          {ITEM_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="Project" value={item.project ?? ""} disabled={done} onChange={(e) => set({ project: e.target.value || null })}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
        <span className={`status-chip ${item.confidence === "high" ? "ok" : item.confidence === "medium" ? "next" : "warn"}`} title="How plainly the text states it">{item.confidence} confidence</span>
        {done && <span className={`status-chip ${item.state === "accepted" ? "ok" : ""}`}>{item.state}</span>}
      </div>
      <input className="exec-title" aria-label="Title" value={item.title} disabled={done} onChange={(e) => set({ title: e.target.value })} />
      <textarea aria-label="Summary" rows={2} value={item.summary} disabled={done} onChange={(e) => set({ summary: e.target.value })} />
      {dated && (
        <div className="exec-row">
          {item.kind === "commitment" && <label className="field grow"><span>Owner</span><input value={item.owner} disabled={done} onChange={(e) => set({ owner: e.target.value })} /></label>}
          <label className="field"><span>Due</span><input type="date" value={item.due} disabled={done} onChange={(e) => set({ due: e.target.value })} /></label>
        </div>
      )}
      {item.kind === "commitment" && !item.owner.trim() && !done && <p className="muted small">No owner was named. Add one, or it is saved without.</p>}
      {item.quote && <blockquote className="exec-quote">{item.quote}</blockquote>}
      {!done && noteMatches.length > 0 && (
        <fieldset className="exec-similar">
          <legend>This may repeat an existing note</legend>
          <label className="check"><input type="radio" checked={choice === "new"} onChange={() => setChoice("new")} /> Save as a new note</label>
          {noteMatches.map((s) => (
            <label key={s.ref} className="check"><input type="radio" checked={choice === s.ref} onChange={() => setChoice(s.ref)} /> Replace <NoteLink row={s} /></label>
          ))}
        </fieldset>
      )}
      {!done && item.similar.some((s) => s.ref.startsWith("milestone:")) && <p className="muted small">A milestone with a similar name exists: {item.similar[0].title}.</p>}
      {problem && <p className="error small">{problem}</p>}
      {!done && why && item.title.trim() && <p className="muted small">{why}</p>}
      {item.result?.ref && !item.result.ref.startsWith("milestone:") && <p className="small">Saved as <NoteLink row={{ ref: item.result.ref, title: item.title }} /></p>}
      {!done && (
        <div className="actions">
          <button onClick={onReject} disabled={busy}><X size="1em" aria-hidden /> Skip</button>
          {problem?.startsWith("A similar note") && <button onClick={() => onAccept(undefined, true)} disabled={busy || !!why || !ctx.ready}>Save anyway</button>}
          <button className="primary" onClick={() => onAccept(choice === "new" ? undefined : choice)} disabled={busy || !!why || !ctx.ready} title={ctx.ready ? undefined : "Loading your notes"}>
            <Check size="1em" aria-hidden /> {choice === "new" ? "Accept" : "Accept and replace"}
          </button>
        </div>
      )}
    </article>
  );
}

/** Review one capture batch: edit, accept or skip each item. */
export function ReviewDialog({ id, projects, onClose }: { id: string; projects: Project[]; onClose: () => void }) {
  const client = useQueryClient();
  const batches = useRecords<CaptureBatch>("capture");
  const stored = batches.data?.find((b) => b.id === id);
  const ctx = useWriteContext(projects, stored?.source.label ?? "");
  const [edits, setEditState] = useState<Record<string, CaptureItem>>({});
  // Saves read the latest edits, not the ones of the render that started them.
  const latest = useRef(edits);
  const setEdits = (f: (e: Record<string, CaptureItem>) => Record<string, CaptureItem>) => { latest.current = f(latest.current); setEditState(latest.current); };
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<{ item: CaptureItem; ref: string } | null>(null);
  const [showText, setShowText] = useState(false);
  if (batches.isLoading) return <Modal title="Review capture" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  if (!stored) return <Modal title="Review capture" onClose={onClose}><p className="muted">This capture is no longer here.</p></Modal>;
  const items = stored.items.map((i) => edits[i.id] ?? i);

  const save = (...next: CaptureItem[]) => {
    setEdits((e) => ({ ...e, ...Object.fromEntries(next.map((n) => [n.id, n])) }));
    return putRecord<CaptureBatch>("capture", { ...stored, items: stored.items.map((i) => latest.current[i.id] ?? i) });
  };

  const accept = async (item: CaptureItem, replace?: string, anyway?: boolean) => {
    setBusy(item.id);
    setProblems((p) => ({ ...p, [item.id]: "" }));
    try {
      const write = planWrite(item, ctx, replace);
      const replaced = write.kind === "note" && write.payload.supersedes ? replace : undefined;
      const result = { ...(await perform(write, anyway)), superseded: replaced };
      await save({ ...item, state: "accepted" as const, result });
      await refreshStore(client);
    } catch (e) {
      const p = classify(e);
      setProblems((all) => ({ ...all, [item.id]: p.kind === "similar" ? `A similar note exists: "${p.title ?? p.ref}". Save this one anyway, or skip it.` : p.message }));
    } finally { setBusy(null); }
  };

  const reject = (...items: CaptureItem[]) => save(...items.map((i) => ({ ...i, state: "rejected" as const }))).catch((e) => toast(String(e), "error"));

  const pending = pendingItems(items);
  return (
    <Modal title={`Review: ${stored.source.label}`} onClose={onClose} wide locked={!!busy}>
      <div className="exec-review">
        <p className="muted small">
          {items.length ? `${items.length} item${items.length === 1 ? "" : "s"} found, ${pending.length} waiting. ` : "No items were found. "}
          Accepted notes and commitments go to Living Memory; milestones stay in Hivemind.
        </p>
        {stored.questions.length > 0 && (
          <div className="banner"><strong>Questions to settle</strong><ul>{stored.questions.map((q) => <li key={q}>{q}</li>)}</ul></div>
        )}
        {items.map((item) => (
          <ItemCard key={item.id} item={item} projects={projects} ctx={ctx} busy={!!busy} problem={problems[item.id] || undefined}
            onChange={(next) => setEdits((e) => ({ ...e, [item.id]: next }))}
            onAccept={(replace, anyway) => (replace ? setReplacing({ item, ref: replace }) : accept(item, undefined, anyway))}
            onReject={() => reject(item)} />
        ))}
        <button className="link small" onClick={() => setShowText(!showText)}>{showText ? "Hide" : "Show"} the captured text</button>
        {showText && <pre className="briefing-text">{stored.text}</pre>}
        <div className="actions">
          {pending.length > 1 && <button onClick={() => reject(...pending)} disabled={!!busy}>Skip the rest</button>}
          <button className="primary" onClick={onClose} disabled={!!busy}>{pending.length ? "Later" : "Done"}</button>
        </div>
      </div>
      {replacing && (
        <Confirm title="Replace the existing note?" action="Replace"
          message={`The new note supersedes "${replacing.item.similar.find((s) => s.ref === replacing.ref)?.title}". The old note is kept as superseded, and the change can be undone from Activity.`}
          onAnswer={(yes) => { const r = replacing; setReplacing(null); if (yes) accept(r.item, r.ref); }} />
      )}
    </Modal>
  );
}
